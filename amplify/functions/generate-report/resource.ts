import { Construct } from 'constructs';
import { defineFunction } from '@aws-amplify/backend';
import { Function, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Duration } from 'aws-cdk-lib';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
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
      timeout: Duration.seconds(60),
      environment: {
        BEDROCK_REGION: 'eu-north-1',
        SONNET_MODEL_ID: 'eu.anthropic.claude-sonnet-5',
      },
    });

    // EU-only Bedrock (GDPR — no US transfer). The eu-* ARNs match the EU
    // inference profiles + their EU foundation-model targets and exclude US.
    fn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:eu-*::foundation-model/*',
        'arn:aws:bedrock:eu-*:*:inference-profile/*',
      ],
    }));

    return fn;
  }
);
