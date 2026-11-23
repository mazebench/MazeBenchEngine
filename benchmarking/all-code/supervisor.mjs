import { BenchmarkSupervisor as NativeSupervisor } from '../kimi-code/supervisor.mjs';
import { supportsAnyLanguage, codingMode } from './capabilities.mjs';
export class BenchmarkSupervisor extends NativeSupervisor {
  async launch(spec = {}) {
    if (codingMode(spec) !== 'any' || !supportsAnyLanguage(spec)) throw new Error('Choose Any language with a supported ASCII world.');
    return super.launch({ ...spec, tools_enabled: true });
  }
}
