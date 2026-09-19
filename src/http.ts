export const httpMethods = [
  'connect',
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'query',
  'trace',
] as const;

export type HTTPMethod = (typeof httpMethods)[number];
export type UppercaseHTTPMethod = Uppercase<HTTPMethod>;
