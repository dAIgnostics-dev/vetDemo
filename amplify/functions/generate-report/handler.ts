// Alternativni TypeScript handler (keywords → nalaz) preko lokalnog Ollama LLM-a.
// Glavni tok koristi orchestrator.lambda_handler (Python); ovaj je zadržan kao
// minimalni Node entry point — bez Amazon Bedrocka.
import * as fs from 'fs';
import * as path from 'path';

const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';

export const handler = async (event: any) => {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const keywords = body?.keywords || [];
    const keywordsStr = keywords.join(', ');

    // Read examples.text bundled with the function (few-shot kontekst)
    const examplesPath = path.resolve(__dirname, 'examples.text');
    let examplesContent = 'No examples available.';
    if (fs.existsSync(examplesPath)) {
      examplesContent = fs.readFileSync(examplesPath, 'utf-8');
    }

    const promptText = `
Based on the keywords (${keywordsStr}) and the examples below, generate a narrative veterinary report.

EXAMPLES:
${examplesContent}

USER KEYWORDS:
${keywordsStr}

Please generate a professional, narrative veterinary report that follows the style of the examples provided.
`;

    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: promptText }],
        stream: false,
        options: { num_predict: 1000 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }

    const data: any = await response.json();
    return data.message.content;
  } catch (error: any) {
    console.error(error);
    throw new Error(error.message);
  }
};
