import { ExecutionGraph } from '../upstream/templates/image-pipeline/src/execution/ExecutionGraph';
import { getNodeDefinitions } from '../upstream/templates/image-pipeline/src/nodes/nodeTypes';
import { getNodePorts } from '../upstream/templates/image-pipeline/src/nodes/nodePorts';
import { arePortDataTypesCompatible } from '../upstream/templates/image-pipeline/src/ports/portCompatibility';
console.log(JSON.stringify({ ExecutionGraph: typeof ExecutionGraph, getNodeDefinitions: typeof getNodeDefinitions, getNodePorts: typeof getNodePorts, imageToTextCompatible: arePortDataTypesCompatible('image', 'text') }));
process.exit(0);
