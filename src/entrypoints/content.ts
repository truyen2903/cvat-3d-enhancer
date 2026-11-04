import { bootstrapContentExtension } from '../core/bootstrap';
import { rootLogger } from '../core/logger';

const log = rootLogger.child('content-entrypoint');

void bootstrapContentExtension().catch((err) => {
  log.error('Failed to bootstrap CVAT 3D Enhancer content script', err);
});
