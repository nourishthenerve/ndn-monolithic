// TASK 4.1.1: the WebSocket-shaped twin of route-protection.ts's
// createRequestAuthorizer. A browser's `WebSocket` constructor cannot set
// an `Authorization` header on the handshake, so the token travels as
// `?token=` on the connect URL instead — `identitySource` says so
// explicitly, and API Gateway keys its own authorizer-result cache on this
// value the same way route-protection.ts's HTTP authorizer is keyed on the
// header.
//
// Pure CDK wiring, no runtime logic — the decision is
// services/api/src/ws-authorizer.ts, deployed as its own Lambda
// (WsAuthorizerFunction, infra/src/data-stack.ts) because
// `WebSocketLambdaAuthorizer` always returns an IAM policy document, never
// the HTTP APIs' `{isAuthorized, context}` simple format `AuthorizerFunction`
// returns — the two response shapes cannot share one deployed function.
import { WebSocketLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';

export function createWebSocketConnectAuthorizer(handler: IFunction): WebSocketLambdaAuthorizer {
  return new WebSocketLambdaAuthorizer('WebSocketRequestAuthorizer', handler, {
    authorizerName: 'ndn-ws-request-authorizer',
    identitySource: ['route.request.querystring.token'],
  });
}
