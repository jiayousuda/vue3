'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

var vue = require('vue');
var shared = require('@vue/shared');
var compilerSsr = require('@vue/compiler-ssr');
var stream = require('stream');

// leading comma for empty string ""
const shouldIgnoreProp = shared.makeMap(`,key,ref,innerHTML,textContent`);
function ssrRenderAttrs(props, tag) {
    let ret = '';
    for (const key in props) {
        if (shouldIgnoreProp(key) ||
            shared.isOn(key) ||
            (tag === 'textarea' && key === 'value')) {
            continue;
        }
        const value = props[key];
        if (key === 'class') {
            ret += ` class="${ssrRenderClass(value)}"`;
        }
        else if (key === 'style') {
            ret += ` style="${ssrRenderStyle(value)}"`;
        }
        else {
            ret += ssrRenderDynamicAttr(key, value, tag);
        }
    }
    return ret;
}
// render an attr with dynamic (unknown) key.
function ssrRenderDynamicAttr(key, value, tag) {
    if (!isRenderableValue(value)) {
        return ``;
    }
    const attrKey = tag && tag.indexOf('-') > 0
        ? key // preserve raw name on custom elements
        : shared.propsToAttrMap[key] || key.toLowerCase();
    if (shared.isBooleanAttr(attrKey)) {
        return value === false ? `` : ` ${attrKey}`;
    }
    else if (shared.isSSRSafeAttrName(attrKey)) {
        return value === '' ? ` ${attrKey}` : ` ${attrKey}="${shared.escapeHtml(value)}"`;
    }
    else {
        console.warn(`[@vue/server-renderer] Skipped rendering unsafe attribute name: ${attrKey}`);
        return ``;
    }
}
// Render a v-bind attr with static key. The key is pre-processed at compile
// time and we only need to check and escape value.
function ssrRenderAttr(key, value) {
    if (!isRenderableValue(value)) {
        return ``;
    }
    return ` ${key}="${shared.escapeHtml(value)}"`;
}
function isRenderableValue(value) {
    if (value == null) {
        return false;
    }
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean';
}
function ssrRenderClass(raw) {
    return shared.escapeHtml(shared.normalizeClass(raw));
}
function ssrRenderStyle(raw) {
    if (!raw) {
        return '';
    }
    if (shared.isString(raw)) {
        return shared.escapeHtml(raw);
    }
    const styles = shared.normalizeStyle(raw);
    return shared.escapeHtml(shared.stringifyStyle(styles));
}

const compileCache = Object.create(null);
function ssrCompile(template, instance) {
    const cached = compileCache[template];
    if (cached) {
        return cached;
    }
    const { code } = compilerSsr.compile(template, {
        isCustomElement: instance.appContext.config.isCustomElement || shared.NO,
        isNativeTag: instance.appContext.config.isNativeTag || shared.NO,
        onError(err) {
            {
                throw err;
            }
        }
    });
    return (compileCache[template] = Function('require', code)(require));
}

function ssrRenderTeleport(parentPush, contentRenderFn, target, disabled, parentComponent) {
    parentPush('<!--teleport start-->');
    let teleportContent;
    if (disabled) {
        contentRenderFn(parentPush);
        teleportContent = `<!---->`;
    }
    else {
        const { getBuffer, push } = createBuffer();
        contentRenderFn(push);
        push(`<!---->`); // teleport end anchor
        teleportContent = getBuffer();
    }
    const context = parentComponent.appContext.provides[vue.ssrContextKey];
    const teleportBuffers = context.__teleportBuffers || (context.__teleportBuffers = {});
    if (teleportBuffers[target]) {
        teleportBuffers[target].push(teleportContent);
    }
    else {
        teleportBuffers[target] = [teleportContent];
    }
    parentPush('<!--teleport end-->');
}

const { createComponentInstance, setCurrentRenderingInstance, setupComponent, renderComponentRoot, normalizeVNode } = vue.ssrUtils;
// Each component has a buffer array.
// A buffer array can contain one of the following:
// - plain string
// - A resolved buffer (recursive arrays of strings that can be unrolled
//   synchronously)
// - An async buffer (a Promise that resolves to a resolved buffer)
function createBuffer() {
    let appendable = false;
    const buffer = [];
    return {
        getBuffer() {
            // Return static buffer and await on items during unroll stage
            return buffer;
        },
        push(item) {
            const isStringItem = shared.isString(item);
            if (appendable && isStringItem) {
                buffer[buffer.length - 1] += item;
            }
            else {
                buffer.push(item);
            }
            appendable = isStringItem;
            if (shared.isPromise(item) || (shared.isArray(item) && item.hasAsync)) {
                // promise, or child buffer with async, mark as async.
                // this allows skipping unnecessary await ticks during unroll stage
                buffer.hasAsync = true;
            }
        }
    };
}
function renderComponentVNode(vnode, parentComponent = null) {
    const instance = createComponentInstance(vnode, parentComponent, null);
    const res = setupComponent(instance, true /* isSSR */);
    const hasAsyncSetup = shared.isPromise(res);
    const prefetch = vnode.type.serverPrefetch;
    if (hasAsyncSetup || prefetch) {
        let p = hasAsyncSetup
            ? res.catch(err => {
                vue.warn(`[@vue/server-renderer]: Uncaught error in async setup:\n`, err);
            })
            : Promise.resolve();
        if (prefetch) {
            p = p.then(() => prefetch.call(instance.proxy)).catch(err => {
                vue.warn(`[@vue/server-renderer]: Uncaught error in serverPrefetch:\n`, err);
            });
        }
        return p.then(() => renderComponentSubTree(instance));
    }
    else {
        return renderComponentSubTree(instance);
    }
}
function renderComponentSubTree(instance) {
    const comp = instance.type;
    const { getBuffer, push } = createBuffer();
    if (shared.isFunction(comp)) {
        renderVNode(push, (instance.subTree = renderComponentRoot(instance)), instance);
    }
    else {
        if (!instance.render &&
            !instance.ssrRender &&
            !comp.ssrRender &&
            shared.isString(comp.template)) {
            comp.ssrRender = ssrCompile(comp.template, instance);
        }
        const ssrRender = instance.ssrRender || comp.ssrRender;
        if (ssrRender) {
            // optimized
            // resolve fallthrough attrs
            let attrs = instance.type.inheritAttrs !== false ? instance.attrs : undefined;
            // inherited scopeId
            const scopeId = instance.vnode.scopeId;
            const treeOwnerId = instance.parent && instance.parent.type.__scopeId;
            const slotScopeId = treeOwnerId && treeOwnerId !== scopeId ? treeOwnerId + '-s' : null;
            if (scopeId || slotScopeId) {
                attrs = { ...attrs };
                if (scopeId)
                    attrs[scopeId] = '';
                if (slotScopeId)
                    attrs[slotScopeId] = '';
            }
            // set current rendering instance for asset resolution
            setCurrentRenderingInstance(instance);
            ssrRender(instance.proxy, push, instance, attrs, 
            // compiler-optimized bindings
            instance.props, instance.setupState, instance.data, instance.ctx);
            setCurrentRenderingInstance(null);
        }
        else if (instance.render) {
            renderVNode(push, (instance.subTree = renderComponentRoot(instance)), instance);
        }
        else {
            vue.warn(`Component ${comp.name ? `${comp.name} ` : ``} is missing template or render function.`);
            push(`<!---->`);
        }
    }
    return getBuffer();
}
function renderVNode(push, vnode, parentComponent) {
    const { type, shapeFlag, children } = vnode;
    switch (type) {
        case vue.Text:
            push(shared.escapeHtml(children));
            break;
        case vue.Comment:
            push(children ? `<!--${shared.escapeHtmlComment(children)}-->` : `<!---->`);
            break;
        case vue.Static:
            push(children);
            break;
        case vue.Fragment:
            push(`<!--[-->`); // open
            renderVNodeChildren(push, children, parentComponent);
            push(`<!--]-->`); // close
            break;
        default:
            if (shapeFlag & 1 /* ELEMENT */) {
                renderElementVNode(push, vnode, parentComponent);
            }
            else if (shapeFlag & 6 /* COMPONENT */) {
                push(renderComponentVNode(vnode, parentComponent));
            }
            else if (shapeFlag & 64 /* TELEPORT */) {
                renderTeleportVNode(push, vnode, parentComponent);
            }
            else if (shapeFlag & 128 /* SUSPENSE */) {
                renderVNode(push, vnode.ssContent, parentComponent);
            }
            else {
                vue.warn('[@vue/server-renderer] Invalid VNode type:', type, `(${typeof type})`);
            }
    }
}
function renderVNodeChildren(push, children, parentComponent) {
    for (let i = 0; i < children.length; i++) {
        renderVNode(push, normalizeVNode(children[i]), parentComponent);
    }
}
function renderElementVNode(push, vnode, parentComponent) {
    const tag = vnode.type;
    let { props, children, shapeFlag, scopeId, dirs } = vnode;
    let openTag = `<${tag}`;
    if (dirs) {
        props = applySSRDirectives(vnode, props, dirs);
    }
    if (props) {
        openTag += ssrRenderAttrs(props, tag);
    }
    openTag += resolveScopeId(scopeId, vnode, parentComponent);
    push(openTag + `>`);
    if (!shared.isVoidTag(tag)) {
        let hasChildrenOverride = false;
        if (props) {
            if (props.innerHTML) {
                hasChildrenOverride = true;
                push(props.innerHTML);
            }
            else if (props.textContent) {
                hasChildrenOverride = true;
                push(shared.escapeHtml(props.textContent));
            }
            else if (tag === 'textarea' && props.value) {
                hasChildrenOverride = true;
                push(shared.escapeHtml(props.value));
            }
        }
        if (!hasChildrenOverride) {
            if (shapeFlag & 8 /* TEXT_CHILDREN */) {
                push(shared.escapeHtml(children));
            }
            else if (shapeFlag & 16 /* ARRAY_CHILDREN */) {
                renderVNodeChildren(push, children, parentComponent);
            }
        }
        push(`</${tag}>`);
    }
}
function resolveScopeId(scopeId, vnode, parentComponent) {
    let res = ``;
    if (scopeId) {
        res = ` ${scopeId}`;
    }
    if (parentComponent) {
        const treeOwnerId = parentComponent.type.__scopeId;
        // vnode's own scopeId and the current rendering component's scopeId is
        // different - this is a slot content node.
        if (treeOwnerId && treeOwnerId !== scopeId) {
            res += ` ${treeOwnerId}-s`;
        }
        if (vnode === parentComponent.subTree) {
            res += resolveScopeId(parentComponent.vnode.scopeId, parentComponent.vnode, parentComponent.parent);
        }
    }
    return res;
}
function applySSRDirectives(vnode, rawProps, dirs) {
    const toMerge = [];
    for (let i = 0; i < dirs.length; i++) {
        const binding = dirs[i];
        const { dir: { getSSRProps } } = binding;
        if (getSSRProps) {
            const props = getSSRProps(binding, vnode);
            if (props)
                toMerge.push(props);
        }
    }
    return vue.mergeProps(rawProps || {}, ...toMerge);
}
function renderTeleportVNode(push, vnode, parentComponent) {
    const target = vnode.props && vnode.props.to;
    const disabled = vnode.props && vnode.props.disabled;
    if (!target) {
        vue.warn(`[@vue/server-renderer] Teleport is missing target prop.`);
        return [];
    }
    if (!shared.isString(target)) {
        vue.warn(`[@vue/server-renderer] Teleport target must be a query selector string.`);
        return [];
    }
    ssrRenderTeleport(push, push => {
        renderVNodeChildren(push, vnode.children, parentComponent);
    }, target, disabled || disabled === '', parentComponent);
}

const { isVNode } = vue.ssrUtils;
async function unrollBuffer(buffer) {
    if (buffer.hasAsync) {
        let ret = '';
        for (let i = 0; i < buffer.length; i++) {
            let item = buffer[i];
            if (shared.isPromise(item)) {
                item = await item;
            }
            if (shared.isString(item)) {
                ret += item;
            }
            else {
                ret += await unrollBuffer(item);
            }
        }
        return ret;
    }
    else {
        // sync buffer can be more efficiently unrolled without unnecessary await
        // ticks
        return unrollBufferSync(buffer);
    }
}
function unrollBufferSync(buffer) {
    let ret = '';
    for (let i = 0; i < buffer.length; i++) {
        let item = buffer[i];
        if (shared.isString(item)) {
            ret += item;
        }
        else {
            // since this is a sync buffer, child buffers are never promises
            ret += unrollBufferSync(item);
        }
    }
    return ret;
}
async function renderToString(input, context = {}) {
    if (isVNode(input)) {
        // raw vnode, wrap with app (for context)
        return renderToString(vue.createApp({ render: () => input }), context);
    }
    // rendering an app
    const vnode = vue.createVNode(input._component, input._props);
    vnode.appContext = input._context;
    // provide the ssr context to the tree
    input.provide(vue.ssrContextKey, context);
    const buffer = await renderComponentVNode(vnode);
    await resolveTeleports(context);
    return unrollBuffer(buffer);
}
async function resolveTeleports(context) {
    if (context.__teleportBuffers) {
        context.teleports = context.teleports || {};
        for (const key in context.__teleportBuffers) {
            // note: it's OK to await sequentially here because the Promises were
            // created eagerly in parallel.
            context.teleports[key] = await unrollBuffer((await Promise.all(context.__teleportBuffers[key])));
        }
    }
}

const { isVNode: isVNode$1 } = vue.ssrUtils;
async function unrollBuffer$1(buffer, stream) {
    if (buffer.hasAsync) {
        for (let i = 0; i < buffer.length; i++) {
            let item = buffer[i];
            if (shared.isPromise(item)) {
                item = await item;
            }
            if (shared.isString(item)) {
                stream.push(item);
            }
            else {
                await unrollBuffer$1(item, stream);
            }
        }
    }
    else {
        // sync buffer can be more efficiently unrolled without unnecessary await
        // ticks
        unrollBufferSync$1(buffer, stream);
    }
}
function unrollBufferSync$1(buffer, stream) {
    for (let i = 0; i < buffer.length; i++) {
        let item = buffer[i];
        if (shared.isString(item)) {
            stream.push(item);
        }
        else {
            // since this is a sync buffer, child buffers are never promises
            unrollBufferSync$1(item, stream);
        }
    }
}
function renderToStream(input, context = {}) {
    if (isVNode$1(input)) {
        // raw vnode, wrap with app (for context)
        return renderToStream(vue.createApp({ render: () => input }), context);
    }
    // rendering an app
    const vnode = vue.createVNode(input._component, input._props);
    vnode.appContext = input._context;
    // provide the ssr context to the tree
    input.provide(vue.ssrContextKey, context);
    const stream$1 = new stream.Readable();
    Promise.resolve(renderComponentVNode(vnode))
        .then(buffer => unrollBuffer$1(buffer, stream$1))
        .then(() => {
        stream$1.push(null);
    })
        .catch(error => {
        stream$1.destroy(error);
    });
    return stream$1;
}

function ssrRenderComponent(comp, props = null, children = null, parentComponent = null) {
    return renderComponentVNode(vue.createVNode(comp, props, children), parentComponent);
}

function ssrRenderSlot(slots, slotName, slotProps, fallbackRenderFn, push, parentComponent) {
    // template-compiled slots are always rendered as fragments
    push(`<!--[-->`);
    const slotFn = slots[slotName];
    if (slotFn) {
        const scopeId = parentComponent && parentComponent.type.__scopeId;
        const slotBuffer = [];
        const bufferedPush = (item) => {
            slotBuffer.push(item);
        };
        const ret = slotFn(slotProps, bufferedPush, parentComponent, scopeId ? ` ${scopeId}-s` : ``);
        if (Array.isArray(ret)) {
            // normal slot
            renderVNodeChildren(push, ret, parentComponent);
        }
        else {
            // ssr slot.
            // check if the slot renders all comments, in which case use the fallback
            let isEmptySlot = true;
            for (let i = 0; i < slotBuffer.length; i++) {
                if (!isComment(slotBuffer[i])) {
                    isEmptySlot = false;
                    break;
                }
            }
            if (isEmptySlot) {
                if (fallbackRenderFn) {
                    fallbackRenderFn();
                }
            }
            else {
                for (let i = 0; i < slotBuffer.length; i++) {
                    push(slotBuffer[i]);
                }
            }
        }
    }
    else if (fallbackRenderFn) {
        fallbackRenderFn();
    }
    push(`<!--]-->`);
}
const commentRE = /^<!--.*-->$/;
function isComment(item) {
    return typeof item === 'string' && commentRE.test(item);
}

function ssrInterpolate(value) {
    return shared.escapeHtml(shared.toDisplayString(value));
}

function ssrRenderList(source, renderItem) {
    if (shared.isArray(source) || shared.isString(source)) {
        for (let i = 0, l = source.length; i < l; i++) {
            renderItem(source[i], i);
        }
    }
    else if (typeof source === 'number') {
        for (let i = 0; i < source; i++) {
            renderItem(i + 1, i);
        }
    }
    else if (shared.isObject(source)) {
        if (source[Symbol.iterator]) {
            const arr = Array.from(source);
            for (let i = 0, l = arr.length; i < l; i++) {
                renderItem(arr[i], i);
            }
        }
        else {
            const keys = Object.keys(source);
            for (let i = 0, l = keys.length; i < l; i++) {
                const key = keys[i];
                renderItem(source[key], key, i);
            }
        }
    }
}

async function ssrRenderSuspense(push, { default: renderContent }) {
    if (renderContent) {
        renderContent();
    }
    else {
        push(`<!---->`);
    }
}

const ssrLooseEqual = shared.looseEqual;
function ssrLooseContain(arr, value) {
    return shared.looseIndexOf(arr, value) > -1;
}
// for <input :type="type" v-model="model" value="value">
function ssrRenderDynamicModel(type, model, value) {
    switch (type) {
        case 'radio':
            return shared.looseEqual(model, value) ? ' checked' : '';
        case 'checkbox':
            return (Array.isArray(model)
                ? ssrLooseContain(model, value)
                : model)
                ? ' checked'
                : '';
        default:
            // text types
            return ssrRenderAttr('value', model);
    }
}
// for <input v-bind="obj" v-model="model">
function ssrGetDynamicModelProps(existingProps = {}, model) {
    const { type, value } = existingProps;
    switch (type) {
        case 'radio':
            return shared.looseEqual(model, value) ? { checked: true } : null;
        case 'checkbox':
            return (Array.isArray(model)
                ? ssrLooseContain(model, value)
                : model)
                ? { checked: true }
                : null;
        default:
            // text types
            return { value: model };
    }
}

exports.renderToStream = renderToStream;
exports.renderToString = renderToString;
exports.ssrGetDynamicModelProps = ssrGetDynamicModelProps;
exports.ssrInterpolate = ssrInterpolate;
exports.ssrLooseContain = ssrLooseContain;
exports.ssrLooseEqual = ssrLooseEqual;
exports.ssrRenderAttr = ssrRenderAttr;
exports.ssrRenderAttrs = ssrRenderAttrs;
exports.ssrRenderClass = ssrRenderClass;
exports.ssrRenderComponent = ssrRenderComponent;
exports.ssrRenderDynamicAttr = ssrRenderDynamicAttr;
exports.ssrRenderDynamicModel = ssrRenderDynamicModel;
exports.ssrRenderList = ssrRenderList;
exports.ssrRenderSlot = ssrRenderSlot;
exports.ssrRenderStyle = ssrRenderStyle;
exports.ssrRenderSuspense = ssrRenderSuspense;
exports.ssrRenderTeleport = ssrRenderTeleport;
exports.ssrRenderVNode = renderVNode;
