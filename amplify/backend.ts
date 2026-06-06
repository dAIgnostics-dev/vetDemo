import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { generateReport } from './functions/generate-report/resource';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 *
 * Napomena: generiranje nalaza ide preko lokalnog Ollama servera (vidi
 * amplify/functions/generate-report/llm.py), pa nisu potrebne Bedrock IAM
 * dozvole. Lokalni razvoj koristi local/server.py umjesto ovog Amplify stacka.
 */
const backend = defineBackend({
  auth,
  data,
  generateReport
});

export { backend };
