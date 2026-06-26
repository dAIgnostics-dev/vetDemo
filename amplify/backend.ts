import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { generateReport } from './functions/generate-report/resource';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Function } from 'aws-cdk-lib/aws-lambda';

/**
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */
const backend = defineBackend({
  auth,
  data,
  generateReport
});

const generateReportFn = backend.generateReport.resources.lambda as Function;

generateReportFn.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['bedrock:InvokeModel'],
    resources: [
      'arn:aws:bedrock:*::foundation-model/*',
      'arn:aws:bedrock:*:*:inference-profile/*'
    ],
  })
);

generateReportFn.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      'aws-marketplace:ViewSubscriptions',
      'aws-marketplace:Subscribe',
      'aws-marketplace:Unsubscribe',
    ],
    resources: ['*'],
  })
);

// Grant authenticated users permission to call Bedrock and Transcribe directly (for voice input)
const authRole = backend.auth.resources.authenticatedUserIamRole;

authRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['bedrock:InvokeModel'],
    resources: [
      'arn:aws:bedrock:*::foundation-model/*',
      'arn:aws:bedrock:*:*:inference-profile/*'
    ],
  })
);

authRole.addToPrincipalPolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ['transcribe:StartStreamTranscription'],
    resources: ['*'],
  })
);
