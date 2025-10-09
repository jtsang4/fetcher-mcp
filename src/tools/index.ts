import { fetchUrlTool, fetchUrl } from './fetchUrl.js';
import { fetchUrlsTool, fetchUrls } from './fetchUrls.js';
import { browserInstallTool, browserInstall } from './browserInstall.js';
import { getLinkTool, getLink } from './getLink.js';

// Export tool definitions
export const tools = [
  fetchUrlTool,
  fetchUrlsTool,
  browserInstallTool,
  getLinkTool
];

// Export tool implementations
export const toolHandlers = {
  [fetchUrlTool.name]: fetchUrl,
  [fetchUrlsTool.name]: fetchUrls,
  [browserInstallTool.name]: browserInstall,
  [getLinkTool.name]: getLink
};