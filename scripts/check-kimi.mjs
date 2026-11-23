import {kimiInstallationStatus} from '../benchmarking/kimi-v2/status.mjs';
const status=await kimiInstallationStatus();
console.log(JSON.stringify(status,null,2));
if(!status.launch_ready)process.exitCode=1;
