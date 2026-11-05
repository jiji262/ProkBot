import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../server/security.mjs';
import { MediaServices } from './media-services.mjs';
import { WebServices } from './web-services.mjs';
import { createVideoAnalysisSession } from './media-video-session.mjs';
import { mediaDefaults, mediaModels, describeMediaModels } from '../server/media-settings.mjs';
import { webDefaults, webRoute } from '../server/web-settings.mjs';
import { internalMediaClient, remoteMediaServices, remoteWebServices } from './media-client.mjs';

const snapshot = (directory, filename, fallback) => {
  try { return JSON.parse(readFileSync(join(directory, filename), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};

/** Decorate the original attachment store; preserve uploads, previews, image cards and source accessors. */
export async function createLocalServiceRuntime(directory, { call, local = false } = {}) {
  call ??= local ? null : await internalMediaClient();
  const media = call ? remoteMediaServices(call) : await new MediaServices(directory).load();
  const web = call ? remoteWebServices(call) : new WebServices(directory);
  const mediaConfig = () => snapshot(directory, 'media.json', mediaDefaults);
  const models = kind => mediaModels(mediaConfig(), kind);
  const enabled = kind => models(kind).some(item => item.id === mediaConfig().defaults[kind]);
  const describe = kind => describeMediaModels(models(kind));
  const webService = (kind, options) => {
    const service = kind === 'search' ? web.createWebSearch(options) : web.createWebFetch(options);
    service.available = modelId => {
      const current = modelId ?? options?.modelId;
      return Boolean(webRoute(snapshot(directory, 'web-services.json', webDefaults), kind, typeof current === 'function' ? current() : current));
    };
    service.forModel = modelId => webService(kind, { ...options, modelId });
    return service;
  };
  return {
    media, web,
    createWebSearch: options => webService('search', options),
    createWebFetch: options => webService('fetch', options),
    videoAnalysisEnabled: kind => enabled(kind),
    createVideoSession: (kind, onRequestId) => createVideoAnalysisSession(media, kind, onRequestId),
    decorateAttachments(original) {
      return { ...original,
        createGenerateImageService(options) {
          const service = media.createGenerateImageService(options);
          service.available = () => enabled('image'); service.describeModels = () => describe('image');
          service.additionalTools = ({ host, defineCommunicateTool, z }) => {
            if (!enabled('video')) return [];
            return [defineCommunicateTool({}, {
              id: 'PLATFORM_ACTION', name: 'GenerateVideo',
              description: `Generate a video with a configured Host model. The saved path can be attached with SendToUser.\n${describe('video')}`,
              parameters: z.object({ description: z.string().min(1), model: z.string().optional(),
                aspect_ratio: z.string().optional(), parameters: z.record(z.unknown()).optional(),
                reference_image_paths: z.array(z.string()).max(10).optional(),
                job_id: z.string().optional().describe('Resume a previously submitted job with the same arguments.') }),
              describeActivity: args => ({ detail: args.description.slice(0, 120) }),
              execute: async (ctx, args, deps) => {
                const references = [];
                for (const path of args.reference_image_paths ?? []) {
                  const image = await original.readImage({ path });
                  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(image?.dataUrl ?? '');
                  check(match, 400, 'Reference must be an image attachment on this Host');
                  references.push({ mimeType: match[1], data: match[2] });
                }
                const result = await media.generate('video', { prompt: args.description, model: args.model,
                  aspectRatio: args.aspect_ratio, parameters: args.parameters, references },
                  { requestId: deps.toolCallId, jobId: args.job_id, signal: ctx.signal });
                const files = [];
                for (const output of result.outputs) {
                  const extension = output.mimeType === 'video/webm' ? 'webm' : 'mp4';
                  const stored = await original.ingestBytes(host.getAgentDirImpl(), `video-${result.jobId}.${extension}`, new Uint8Array(output.bytes));
                  files.push(stored.absolutePath);
                }
                return JSON.stringify({ jobId: result.jobId, model: result.modelId, files,
                  instruction: 'Attach the generated video files with SendToUser.' });
              },
            })];
          };
          return service;
        },
        async generateAvatarImage(description) {
          const result = await media.generate('image', { prompt: description });
          return { imageBase64: result.outputs[0].bytes.toString('base64'), mimeType: result.outputs[0].mimeType };
        },
      };
    },
  };
}
