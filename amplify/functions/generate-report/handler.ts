import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import * as fs from 'fs';
import * as path from 'path';

const client = new BedrockRuntimeClient({ region: "eu-north-1" });

export const handler = async (event: any) => {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const keywords = body?.keywords || [];
    const keywordsStr = keywords.join(', ');

    // Read examples.text bundled with the function
    // In Gen 2 bundling, assets are typically in the same directory as the handler
    const examplesPath = path.resolve(__dirname, 'examples.text');
    let examplesContent = "No examples available.";
    
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

    const modelId = "anthropic.claude-3-sonnet-20240229-v1:0";
    
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: promptText
        }
      ]
    };

    const command = new InvokeModelCommand({
      modelId,
      body: JSON.stringify(payload),
      contentType: "application/json",
      accept: "application/json",
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const generatedReport = responseBody.content[0].text;

    return generatedReport;
  } catch (error: any) {
    console.error(error);
    throw new Error(error.message);
  }
};
