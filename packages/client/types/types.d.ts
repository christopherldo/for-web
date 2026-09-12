import type { SolidOptions } from "solid-dnd-directive";
import { Setter } from "solid-js";

import type { Placement } from "@floating-ui/dom";
import type { Channel, Client, ServerMember, ServerRole, User } from "stoat.js";

declare global {
  interface Window {
    __TAURI__: object;
    soarapaDesktop?: {
      shouldContinueAppShare: () => Promise<boolean>;
      isRetargeting: () => Promise<boolean>;
      prepareSilentAppShare: () => void;
      waitForAppWindow: () => Promise<{ id: string; name: string } | null>;
      clearAppShare: () => void;
      retargetDone: () => void;
      onRetarget: (cb: () => void) => () => void;
      nativeWgcAvailable?: () => Promise<boolean>;
      pickCaptureTarget?: () => Promise<
        | {
            kind: "screen";
            id: string;
            name: string;
          }
        | {
            kind: "window";
            hwnd: string;
            id: string;
            name: string;
            appId?: string | null;
          }
        | null
      >;
      forceNextScreenSource?: (id: string) => void;
      getPrimaryScreenId?: () => Promise<string | null>;
      startProcessAudio?: (targets: {
        pids: number[];
        processNames: string[];
      }) => Promise<boolean>;
      stopProcessAudio?: () => void;
      appAudioTargets?: (appId: string | null) => Promise<{
        pids: number[];
        processNames: string[];
      }>;
      onAudioSamples?: (
        cb: (msg: {
          sampleRate: number;
          channels: number;
          frames: number;
          data: Uint8Array | ArrayBuffer;
        }) => void,
      ) => () => void;
      logShareStats?: (stats: Record<string, unknown>) => void;
      /**
       * Versão da ponte nativa. Ausente (undefined) = app 1.0.27 ou anterior,
       * onde a captura só aceita `maxWidth` posicional e devolve RGBA.
       */
      nativeCaptureApi?: number;
      /** CaptureOptions do native-wgc — ver soarapa-desktop/docs-stream-quality.md. */
      startNativeCapture?: (
        hwnd: string,
        options?:
          | {
              maxWidth?: number;
              maxHeight?: number;
              targetFps?: number;
              nv12?: boolean;
            }
          | number,
      ) => void;
      switchNativeCapture?: (
        hwnd: string,
        options?:
          | {
              maxWidth?: number;
              maxHeight?: number;
              targetFps?: number;
              nv12?: boolean;
            }
          | number,
      ) => void;
      stopNativeCapture?: () => void;
      onNativeFrame?: (
        cb: (frame: {
          width: number;
          height: number;
          /** "nv12" (padrão) ou "rgba" no fallback. Nunca assuma. */
          format?: "nv12" | "rgba";
          data: ArrayBuffer | Uint8Array;
        }) => void,
      ) => () => void;
      onNativeRetarget?: (
        cb: (payload: {
          hwnd: string;
          id: string;
          name: string;
          switched?: boolean;
        }) => void,
      ) => () => void;
      onNativeEnded?: (cb: () => void) => () => void;
    };
  }
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      dndzone: SolidOptions;

      scrollable:
        | true
        | {
            /**
             * Colour customisation
             */
            palette?: "default" | "settings";

            /**
             * Scroll direction
             */
            direction?: "x" | "y";

            /**
             * Offset to apply to top of scroll container
             */
            offsetTop?: number;

            /**
             * Whether to only show scrollbar on hover
             */
            showOnHover?: boolean;

            /**
             * Pass-through class names
             */
            class?: string;
          };
      invisibleScrollable:
        | true
        | {
            /**
             * Scroll direction
             */
            direction?: "x" | "y";

            /**
             * Pass-through class names
             */
            class?: string;
          };
      floating: {
        tooltip?: {
          /**
           * Where the tooltip should be placed
           */
          placement: Placement;
        } & (
          | {
              /**
               * Tooltip content
               */
              content: Component;

              /**
               * Aria label fallback
               */
              aria: string;
            }
          | {
              /**
               * Tooltip content
               */
              content: string | undefined;

              /**
               * Content is used as aria fallback
               */
              aria?: undefined;
            }
        );
        userCard?: {
          /**
           * User to display
           */
          user: User;

          /**
           * Member to display
           */
          member?: ServerMember;

          /**
           * Bot to display
           */
          bot?: { owner: string };
        };
        contextMenu?: Component;
        contextMenuHandler?: "click" | "contextmenu";
        autoComplete?: {
          state: Accessor<AutoCompleteState>;
          selection: Accessor<number>;
          setSelection: Setter<number>;
          select: (index: number) => void;
        };
      };
      autoComplete:
        | true
        | {
            client?: Client;
            onKeyDown?: (
              event: KeyboardEvent & { currentTarget: HTMLTextAreaElement },
            ) => void;
            searchSpace?: {
              users?: User[];
              members?: ServerMember[];
              channels?: Channel[];
              roles?: ServerRole[];
            };
          };
    }
  }
}
