import { Construct } from 'constructs';
import { defineFunction } from '@aws-amplify/backend';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Duration } from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const generateReport = defineFunction(
  (scope: Construct) => {
    const fn = new Function(scope, 'GenerateReportPython', {
      runtime: Runtime.PYTHON_3_12,
      handler: 'orchestrator.lambda_handler',
      code: Code.fromAsset(path.resolve(__dirname)),
      timeout: Duration.seconds(120),
      environment: {
        // Generiranje ide preko lokalnog Ollama servera (vidi llm.py).
        OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://localhost:11434',
        OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
      },
    });

    return fn;
  }
);
