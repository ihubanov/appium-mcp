import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import {getViewerServer} from '../../walkthrough/viewer-server.js';
import {Walkthrough, type WalkthroughStep} from '../../walkthrough/walkthrough.js';
import {findElementSchema} from '../interactions/find.js';
import {resolveDriver, textResult, errorResult, toolErrorMessage} from '../tool-response.js';

/** The tool is opt-in because it serves a local viewer page that can forward taps to the device. */
export function isWalkthroughEnabled(): boolean {
  return ['true', '1'].includes(String(process.env.APPIUM_MCP_WALKTHROUGH_ENABLED).toLowerCase());
}

/** Walkthroughs still on screen, keyed by id. */
const walkthroughs = new Map<string, Walkthrough>();
const MAX_WALKTHROUGHS = 10;

const stepSchema = z.object({
  strategy: findElementSchema.shape.strategy
    .optional()
    .describe(
      'Locator strategy of the element to highlight, as for appium_find_element. Omit for a caption-only step.',
    ),
  selector: z.string().optional().describe('Selector for strategy.'),
  title: z.string().optional().describe('Short heading for the caption.'),
  text: z.string().describe('What to tell the person at this step: one idea, plain words.'),
  action: z
    .enum(['none', 'tap', 'type', 'swipe'])
    .optional()
    .describe(
      'What the step does. Demo mode performs it; in guided mode the person does it, or Next does it for them.',
    ),
  value: z.string().optional().describe('Text to type for action=type.'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('action=swipe: finger direction, across the element if given, else the screen. Default up.'),
  advance: z
    .enum(['next', 'tap', 'change'])
    .optional()
    .describe(
      'Guided: what moves on — the Next button, a tap on the highlighted element, or any screen change. Default from action: tap→tap, type/swipe→change, else next.',
    ),
  readMs: z
    .number()
    .int()
    .min(0)
    .max(30000)
    .optional()
    .describe('Demo: ms to hold the step on screen before acting (default 5000).'),
});

export const walkthroughSchema = z.object({
  action: z
    .enum(['start', 'resume', 'stop'])
    .describe('start a new walkthrough; resume one that returned waiting:true; stop one now.'),
  steps: z.array(stepSchema).min(1).max(50).optional().describe('action=start: the walkthrough, in order.'),
  mode: z
    .enum(['guided', 'demo'])
    .optional()
    .describe(
      'action=start. guided (default): point and explain; the person does each step. demo: perform each step on the device while the overlay narrates. Demo never types into password fields.',
    ),
  walkthroughId: z.string().optional().describe('action=resume|stop: id returned by start.'),
  waitSeconds: z
    .number()
    .int()
    .min(5)
    .max(600)
    .optional()
    .describe('How long this call waits for the person before returning waiting:true. Default 120.'),
  sessionId: z.string().optional().describe('Session ID; defaults to the active session.'),
});

export default function walkthrough(server: FastMCP): void {
  server.addTool({
    name: 'appium_walkthrough',
    description: [
      'Show a person how to do something in an app: the device screen is mirrored in a browser page with an animated spotlight, arrow and caption per step.',
      'Use for "show me how…" / "walk me through…" requests, or to demo a flow. start returns a viewer URL; give it to the person.',
      'guided waits for the person (Next, a tap on the highlight, or a screen change); demo performs the steps itself. waiting:true means call again with action=resume.',
    ].join('\n'),
    parameters: walkthroughSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof walkthroughSchema>,
      context: {reportProgress?: (p: {progress: number}) => Promise<void>} | undefined,
    ): Promise<ContentResult> => {
      if (args.action === 'stop' || args.action === 'resume') {
        const existing = args.walkthroughId ? walkthroughs.get(args.walkthroughId) : undefined;
        if (!existing) {
          return errorResult(
            `Unknown walkthroughId "${args.walkthroughId ?? ''}": it finished, was stopped, or never existed.`,
          );
        }
        if (args.action === 'stop') {
          existing.stop();
          walkthroughs.delete(existing.id);
          return textResult(`Walkthrough ${existing.id} stopped.`);
        }
        return await runAndReport(existing, args.waitSeconds, context);
      }

      if (!args.steps?.length) {
        return errorResult('action=start requires steps.');
      }
      const resolved = await resolveDriver(args.sessionId);
      if (!resolved.ok) {
        return resolved.result;
      }
      // One walkthrough per device session: a new one replaces the old.
      for (const [id, w] of walkthroughs) {
        if (w.driver === resolved.driver || walkthroughs.size >= MAX_WALKTHROUGHS) {
          w.stop();
          walkthroughs.delete(id);
        }
      }
      try {
        const w = new Walkthrough(
          resolved.driver,
          args.steps as WalkthroughStep[],
          getViewerServer(),
          args.mode ?? 'guided',
        );
        await w.open();
        walkthroughs.set(w.id, w);
        return await runAndReport(w, args.waitSeconds, context);
      } catch (err: unknown) {
        return errorResult(`Failed to start walkthrough. ${toolErrorMessage(err)}`);
      }
    },
  });
}

async function runAndReport(
  w: Walkthrough,
  waitSeconds: number | undefined,
  context: {reportProgress?: (p: {progress: number}) => Promise<void>} | undefined,
): Promise<ContentResult> {
  let ticks = 0;
  try {
    const status = await w.run((waitSeconds ?? 120) * 1000, () => {
      // Keep the client's request alive while the person takes their time.
      ticks += 1;
      Promise.resolve(context?.reportProgress?.({progress: ticks})).catch(() => {});
    });
    if (w.done) {
      walkthroughs.delete(w.id);
    }
    let note: string;
    if (status.finished) {
      note = 'Walkthrough finished: every step done.';
    } else if (status.stoppedByUser) {
      note = `The person skipped the walkthrough at step ${status.at + 1}.`;
    } else if (status.failed) {
      note = `Step ${status.at + 1} failed (see steps). Fix it and action=resume, or action=stop.`;
    } else if (status.viewers === 0 && status.completed === 0) {
      note = `Nobody has opened the viewer yet. Ask the person to open ${w.url}, then action=resume.`;
    } else {
      note = `The person is still on step ${status.at + 1} of ${status.total}. Call action=resume to keep waiting, or action=stop.`;
    }
    return textResult(
      JSON.stringify({...(w.done ? {} : {walkthroughId: w.id}), viewerUrl: w.url, ...status, note}, null, 2),
    );
  } catch (err: unknown) {
    return errorResult(`Walkthrough ${w.id} failed. ${toolErrorMessage(err)}`);
  }
}
