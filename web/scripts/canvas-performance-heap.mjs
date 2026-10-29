/** Read V8's documented heap snapshot node/edge tables. This is supporting
 * object-sharing evidence, never a substitute for Runtime.getHeapUsage bytes. */
export function analyzeCanvasHeap(snapshot, nodeCount = 500) {
    const { node_fields: nf, edge_fields: ef, edge_types: et } = snapshot.snapshot.meta;
    const nodes = snapshot.nodes, edges = snapshot.edges, strings = snapshot.strings;
    const stride = nf.length, edgeStride = ef.length, countIndex = nf.indexOf("edge_count"), nameIndex = nf.indexOf("name");
    const typeIndex = ef.indexOf("type"), edgeNameIndex = ef.indexOf("name_or_index"), targetIndex = ef.indexOf("to_node");
    const offsets = new Map();
    let edgeOffset = 0;
    for (let offset = 0; offset < nodes.length; offset += stride) { offsets.set(offset, edgeOffset); edgeOffset += nodes[offset + countIndex] * edgeStride; }
    const visitEdges = (offset, callback) => {
        const start = offsets.get(offset), end = start + nodes[offset + countIndex] * edgeStride;
        for (let edge = start; edge < end; edge += edgeStride) {
            const type = et[typeIndex][edges[edge + typeIndex]];
            callback(type, type === "element" ? edges[edge + edgeNameIndex] : strings[edges[edge + edgeNameIndex]], edges[edge + targetIndex]);
        }
    };
    const nodeObjects = new Map();
    for (let offset = 0; offset < nodes.length; offset += stride) visitEdges(offset, (type, name, to) => {
        if (type === "property" && name === "id") {
            const value = strings[nodes[to + nameIndex]];
            if (/^performance-node-\d+$/.test(value)) nodeObjects.set(offset, Number(value.slice("performance-node-".length)));
        }
    });
    const arrays = new Map();
    for (let offset = 0; offset < nodes.length; offset += stride) {
        const members = [];
        visitEdges(offset, (type, _name, to) => { if (type === "element" && nodeObjects.has(to)) members.push(to); });
        if (members.length === nodeCount && new Set(members.map(member => nodeObjects.get(member))).size === nodeCount) arrays.set(offset, members);
    }
    // Cluster by one untouched node. Largest cluster identifies the retained
    // runtime history even if cloud/IDB parsing also holds another graph copy.
    const clusters = new Map();
    for (const members of arrays.values()) {
        const anchor = members.find(member => nodeObjects.get(member) === 1);
        if (!clusters.has(anchor)) clusters.set(anchor, []);
        clusters.get(anchor).push(members);
    }
    const cluster = [...clusters.values()].sort((a, b) => b.length - a.length)[0] || [];
    const unique = new Set(cluster.flat()), unchangedCopies = new Map();
    for (const member of unique) if (nodeObjects.get(member) !== 0) unchangedCopies.set(nodeObjects.get(member), (unchangedCopies.get(nodeObjects.get(member)) || 0) + 1);
    return { matchingNodeObjects: nodeObjects.size, graphArrays: arrays.size, sharingClusterArrays: cluster.length,
        sharingClusterUniqueNodes: unique.size, unchangedNodeMaxCopies: Math.max(0, ...unchangedCopies.values()),
        changedNodeVersions: [...unique].filter(member => nodeObjects.get(member) === 0).length };
}
