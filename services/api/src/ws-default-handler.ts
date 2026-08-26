// TASK 4.1.1 step 1: `$default` exists only so the WebSocket API deploys
// cleanly with a route for every message that doesn't match another route
// key — every inbound message matches `$default` today, since no other
// route is defined yet. Message relay is TASK 4.2.2's job, not this one:
// this handler accepts nothing and does nothing.
import type { APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = async (): Promise<APIGatewayProxyResultV2> => ({ statusCode: 200 });
