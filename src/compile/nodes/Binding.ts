import Node from './shared/Node';
import Element from './Element';
import getObject from '../../utils/getObject';
import getTailSnippet from '../../utils/getTailSnippet';
import flattenReference from '../../utils/flattenReference';
import Compiler from '../Compiler';
import Block from '../dom/Block';
import Expression from './shared/Expression';
import { dimensions } from '../../utils/patterns';

const readOnlyMediaAttributes = new Set([
	'duration',
	'buffered',
	'seekable',
	'played'
]);

// TODO a lot of this element-specific stuff should live in Element —
// Binding should ideally be agnostic between Element and Component

export default class Binding extends Node {
	name: string;
	value: Expression;
	isContextual: boolean;
	usesContext: boolean;
	obj: string;
	prop: string;

	constructor(compiler, parent, scope, info) {
		super(compiler, parent, scope, info);

		this.name = info.name;
		this.value = new Expression(compiler, this, scope, info.value);

		let obj;
		let prop;

		const { name } = getObject(this.value.node);
		this.isContextual = scope.names.has(name);

		if (this.value.node.type === 'MemberExpression') {
			prop = `[✂${this.value.node.property.start}-${this.value.node.property.end}✂]`;
			if (!this.value.node.computed) prop = `'${prop}'`;
			obj = `[✂${this.value.node.object.start}-${this.value.node.object.end}✂]`;

			this.usesContext = true;
		} else {
			obj = 'ctx';
			prop = `'${name}'`;

			this.usesContext = scope.names.has(name);
		}

		this.obj = obj;
		this.prop = prop;
	}

	munge(
		block: Block
	) {
		const node: Element = this.parent;

		const needsLock = node.name !== 'input' || !/radio|checkbox|range|color/.test(node.getStaticAttributeValue('type'));
		const isReadOnly = (
			(node.isMediaNode() && readOnlyMediaAttributes.has(this.name)) ||
			dimensions.test(this.name)
		);

		let updateCondition: string;

		const { name } = getObject(this.value.node);
		const { snippet } = this.value;

		// special case: if you have e.g. `<input type=checkbox bind:checked=selected.done>`
		// and `selected` is an object chosen with a <select>, then when `checked` changes,
		// we need to tell the component to update all the values `selected` might be
		// pointing to
		// TODO should this happen in preprocess?
		const dependencies = new Set(this.value.dependencies);
		this.value.dependencies.forEach((prop: string) => {
			const indirectDependencies = this.compiler.indirectDependencies.get(prop);
			if (indirectDependencies) {
				indirectDependencies.forEach(indirectDependency => {
					dependencies.add(indirectDependency);
				});
			}
		});

		// view to model
		const valueFromDom = getValueFromDom(this.compiler, node, this);
		const handler = getEventHandler(this, this.compiler, block, name, snippet, dependencies, valueFromDom);

		// model to view
		let updateDom = getDomUpdater(node, this, snippet);
		let initialUpdate = updateDom;

		// special cases
		if (this.name === 'group') {
			const bindingGroup = getBindingGroup(this.compiler, this.value.node);

			block.builders.hydrate.addLine(
				`#component._bindingGroups[${bindingGroup}].push(${node.var});`
			);

			block.builders.destroy.addLine(
				`#component._bindingGroups[${bindingGroup}].splice(#component._bindingGroups[${bindingGroup}].indexOf(${node.var}), 1);`
			);
		}

		if (this.name === 'currentTime' || this.name === 'volume') {
			updateCondition = `!isNaN(${snippet})`;

			if (this.name === 'currentTime') initialUpdate = null;
		}

		if (this.name === 'paused') {
			// this is necessary to prevent audio restarting by itself
			const last = block.getUniqueName(`${node.var}_is_paused`);
			block.addVariable(last, 'true');

			updateCondition = `${last} !== (${last} = ${snippet})`;
			updateDom = `${node.var}[${last} ? "pause" : "play"]();`;
			initialUpdate = null;
		}

		// bind:offsetWidth and bind:offsetHeight
		if (dimensions.test(this.name)) {
			initialUpdate = null;
			updateDom = null;
		}

		return {
			name: this.name,
			object: name,
			handler,
			updateDom,
			initialUpdate,
			needsLock: !isReadOnly && needsLock,
			updateCondition,
			isReadOnlyMediaAttribute: this.isReadOnlyMediaAttribute()
		};
	}

	isReadOnlyMediaAttribute() {
		return readOnlyMediaAttributes.has(this.name);
	}
}

function getDomUpdater(
	node: Element,
	binding: Binding,
	snippet: string
) {
	if (binding.isReadOnlyMediaAttribute()) {
		return null;
	}

	if (node.name === 'select') {
		return node.getStaticAttributeValue('multiple') === true ?
			`@selectOptions(${node.var}, ${snippet})` :
			`@selectOption(${node.var}, ${snippet})`;
	}

	if (binding.name === 'group') {
		const type = node.getStaticAttributeValue('type');

		const condition = type === 'checkbox'
			? `~${snippet}.indexOf(${node.var}.__value)`
			: `${node.var}.__value === ${snippet}`;

		return `${node.var}.checked = ${condition};`
	}

	return `${node.var}.${binding.name} = ${snippet};`;
}

function getBindingGroup(compiler: Compiler, value: Node) {
	const { parts } = flattenReference(value); // TODO handle cases involving computed member expressions
	const keypath = parts.join('.');

	// TODO handle contextual bindings — `keypath` should include unique ID of
	// each block that provides context
	let index = compiler.bindingGroups.indexOf(keypath);
	if (index === -1) {
		index = compiler.bindingGroups.length;
		compiler.bindingGroups.push(keypath);
	}

	return index;
}

function getEventHandler(
	binding: Binding,
	compiler: Compiler,
	block: Block,
	name: string,
	snippet: string,
	dependencies: string[],
	value: string,
	isContextual: boolean
) {
	const storeDependencies = [...dependencies].filter(prop => prop[0] === '$').map(prop => prop.slice(1));
	dependencies = [...dependencies].filter(prop => prop[0] !== '$');

	if (binding.isContextual) {
		const tail = binding.value.node.type === 'MemberExpression'
			? getTailSnippet(binding.value.node)
			: '';

		const head = block.bindings.get(name);

		return {
			usesContext: true,
			usesState: true,
			usesStore: storeDependencies.length > 0,
			mutation: `${head}${tail} = ${value};`,
			props: dependencies.map(prop => `${prop}: ctx.${prop}`),
			storeProps: storeDependencies.map(prop => `${prop}: $.${prop}`)
		};
	}

	if (binding.value.node.type === 'MemberExpression') {
		// This is a little confusing, and should probably be tidied up
		// at some point. It addresses a tricky bug (#893), wherein
		// Svelte tries to `set()` a computed property, which throws an
		// error in dev mode. a) it's possible that we should be
		// replacing computations with *their* dependencies, and b)
		// we should probably populate `compiler.target.readonly` sooner so
		// that we don't have to do the `.some()` here
		dependencies = dependencies.filter(prop => !compiler.computations.some(computation => computation.key === prop));

		return {
			usesContext: false,
			usesState: true,
			usesStore: storeDependencies.length > 0,
			mutation: `${snippet} = ${value}`,
			props: dependencies.map((prop: string) => `${prop}: ctx.${prop}`),
			storeProps: storeDependencies.map(prop => `${prop}: $.${prop}`)
		};
	}

	let props;
	let storeProps;

	if (name[0] === '$') {
		props = [];
		storeProps = [`${name.slice(1)}: ${value}`];
	} else {
		props = [`${name}: ${value}`];
		storeProps = [];
	}

	return {
		usesContext: false,
		usesState: false,
		usesStore: false,
		mutation: null,
		props,
		storeProps
	};
}

function getValueFromDom(
	compiler: Compiler,
	node: Element,
	binding: Node
) {
	// <select bind:value='selected>
	if (node.name === 'select') {
		return node.getStaticAttributeValue('multiple') === true ?
			`@selectMultipleValue(${node.var})` :
			`@selectValue(${node.var})`;
	}

	const type = node.getStaticAttributeValue('type');

	// <input type='checkbox' bind:group='foo'>
	if (binding.name === 'group') {
		const bindingGroup = getBindingGroup(compiler, binding.value.node);
		if (type === 'checkbox') {
			return `@getBindingGroupValue(#component._bindingGroups[${bindingGroup}])`;
		}

		return `${node.var}.__value`;
	}

	// <input type='range|number' bind:value>
	if (type === 'range' || type === 'number') {
		return `@toNumber(${node.var}.${binding.name})`;
	}

	if ((binding.name === 'buffered' || binding.name === 'seekable' || binding.name === 'played')) {
		return `@timeRangesToArray(${node.var}.${binding.name})`
	}

	// everything else
	return `${node.var}.${binding.name}`;
}

function isComputed(node: Node) {
	while (node.type === 'MemberExpression') {
		if (node.computed) return true;
		node = node.object;
	}

	return false;
}
