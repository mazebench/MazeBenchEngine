import { antigravityInstallationStatus as previous } from '../antigravity/status.mjs';
import { ModelCatalog } from '../model-catalog/service.mjs';
export const ANTIGRAVITY_PROVIDER='antigravity';
const catalog=new ModelCatalog();
export async function antigravityInstallationStatus(command='agy') {
  const [installation,status]=await Promise.all([previous(command),catalog.provider(ANTIGRAVITY_PROVIDER)]);
  return {...installation, models:status.models, launch_ready:installation.tested&&installation.authenticated&&!status.stale, error:status.error||installation.error};
}
