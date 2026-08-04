import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { generateReport } from './functions/generate-report/resource';
import { extractReferral } from './functions/extract-referral/resource';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Function } from 'aws-cdk-lib/aws-lambda';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  generateReport,
  extractReferral
});

const bedrockInvoke = () =>
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['bedrock:InvokeModel'],
    resources: [
      'arn:aws:bedrock:*::foundation-model/*',
      'arn:aws:bedrock:*:*:inference-profile/*'
    ],
  });

const generateReportFn = backend.generateReport.resources.lambda as Function;
generateReportFn.addToRolePolicy(bedrockInvoke());

const extractReferralFn = backend.extractReferral.resources.lambda as Function;
extractReferralFn.addToRolePolicy(bedrockInvoke());

// Textract has no resource-level permissions, so the wildcard is the only option.
// If an SCP blocks this the deploy fails loudly, and at runtime the function
// degrades to vision-only extraction rather than erroring out.
extractReferralFn.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['textract:AnalyzeDocument', 'textract:DetectDocumentText'],
    resources: ['*'],
  })
);
