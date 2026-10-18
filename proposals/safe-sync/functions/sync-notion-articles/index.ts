// Candidate only. No production deployment has been authorized.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import { makeHandler } from '../_shared/sync-core.mjs';
import { createIO } from '../_shared/supabase-io.mjs';
const env=(name: string): string=>Deno.env.get(name)||'';
const handler=makeHandler({secret:env('SYNC_CRON_SECRET'),applyEnabled:env('SYNC_APPLY_ENABLED')==='true',ioFactory:()=>createIO({env,createClient})});
Deno.serve(async request=>{
  // Configuration failures are sanitized, including errors from ioFactory.
  try{return await handler(request);}
  catch{return new Response(JSON.stringify({error:'server_configuration_error'}),{status:503,headers:{'content-type':'application/json'}});}
});
