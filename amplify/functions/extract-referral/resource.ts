import { Construct } from 'constructs';
import { defineFunction } from '@aws-amplify/backend';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Duration } from 'aws-cdk-lib';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const extractReferral = defineFunction(
  (scope: Construct) => {
    return new Function(scope, 'ExtractReferralPython', {
      runtime: Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: Code.fromAsset(path.resolve(__dirname)),
      // AppSync caps request execution at 30s, so a longer Lambda timeout would
      // only hide the failure instead of surfacing it.
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: {
        TEXTRACT_REGION: 'eu-central-1',
        BEDROCK_REGION: 'eu-north-1',
        MODEL_ID: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    });
  }
);
