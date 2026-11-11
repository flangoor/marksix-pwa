// Supabase Edge Function: server-side HKJC GraphQL proxy.
// Deploy with: supabase functions deploy sync-hkjc
// The endpoint/query is public but undocumented and may change.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const endpoint="https://info.cld.hkjc.com/graphql/base/";
const query=`fragment lotteryDrawsFragment on LotteryDraw {
 id year no openDate closeDate drawDate status snowballCode snowballName_en snowballName_ch
 lotteryPool { sell status totalInvestment jackpot unitBet estimatedPrize derivedFirstPrizeDiv lotteryPrizes { type winningUnit dividend } }
 drawResult { drawnNo xDrawnNo }
}
query marksixResult($lastNDraw: Int, $startDate: String, $endDate: String, $drawType: LotteryDrawType) {
 lotteryDraws(lastNDraw:$lastNDraw startDate:$startDate endDate:$endDate drawType:$drawType) { ...lotteryDrawsFragment }
}`;
serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 try{
  const auth=req.headers.get("Authorization")||"";
  const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:auth}}});
  const {data:{user},error:ue}=await supabase.auth.getUser();if(ue||!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:{...cors,"Content-Type":"application/json"}});
  const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json","Origin":"https://bet.hkjc.com","User-Agent":"Mozilla/5.0 MarkSix-PWA/1.0"},body:JSON.stringify({operationName:"marksixResult",variables:{lastNDraw:50,drawType:"All"},query}),signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`HKJC HTTP ${response.status}`);
  const json=await response.json();if(json.errors?.length)throw new Error(json.errors.map((e:any)=>e.message).join("; "));
  const source=json?.data?.lotteryDraws||[];
  const draws=source.map((d:any)=>{
    const raw=d?.drawResult?.drawnNo||[];const nums=raw.map((x:any)=>Number(typeof x==="object"?(x.no??x.number??x.value):x)).filter((n:number)=>Number.isInteger(n)&&n>=1&&n<=49);
    const dateRaw=d.drawDate||d.closeDate||d.openDate||"";
    const match=String(dateRaw).match(/(\d{4})-(\d{2})-(\d{2})/);
    return {id:String(d.id??`${d.year}/${d.no}`),date:match?`${match[1]}-${match[2]}-${match[3]}`:null,numbers:nums.slice(0,6),extra:nums[6]??null};
  }).filter((d:any)=>d.date&&d.numbers.length===6&&new Set(d.numbers).size===6);
  return new Response(JSON.stringify({draws,source:"HKJC public GraphQL",count:draws.length}),{headers:{...cors,"Content-Type":"application/json"}});
 }catch(e){return new Response(JSON.stringify({error:String(e)}),{status:502,headers:{...cors,"Content-Type":"application/json"}})}
});