import type { FieldDescriptor } from '@filler/core';

declare global {
  // The page agent installed by apps/extension/entrypoints/page-agent.ts.
  var __fillerPageAgent:
    | {
        version: 1;
        scan(): Promise<{
          url: string;
          title: string;
          scannedAt: string;
          fields: FieldDescriptor[];
          errors: string[];
        }>;
        resolve(
          field: Pick<FieldDescriptor, 'id' | 'selector' | 'signature'>,
        ): Promise<Element | null>;
      }
    | undefined;
}
