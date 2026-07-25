import { Construct } from 'constructs';
import { defineFunction } from '@aws-amplify/backend';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Duration } from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const extractFields = defineFunction(
  (scope: Construct) => {
    return new Function(scope, 'ExtractFieldsPython', {
      runtime: Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: Code.fromAsset(path.resolve(__dirname)),
      // Okida se dok doktor jos diktira — kratak timeout drzi obrazac responzivnim.
      timeout: Duration.seconds(20),
      environment: {
        BEDROCK_REGION: 'us-east-1',
        EXTRACT_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      },
    });
  }
);
