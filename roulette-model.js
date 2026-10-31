'use strict';
    const {execFile}=require('node:child_process');const {promisify}=require('node:util');const path=require('node:path');const run=promisify(execFile);const pending=new Map();
    async function predict(windowStart){if(pending.has(windowStart))return pending.get(windowStart);const task=(async()=>{try{const {stdout}=await run(process.env.PYTHON||'python3',[path.join(__dirname,'roulette_model.py')],{timeout:45000,maxBuffer:1024*1024});return JSON.parse(stdout.trim())}catch(error){return{ready:false,status:'error',reason:error.message||'Model inference failed'}}})();pending.set(windowStart,task);if(pending.size>8)pending.delete(pending.keys().next().value);return task}
    module.exports={predict};
    