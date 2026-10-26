'use strict'
const { MacroActionError, assertFacade } = require('./contract.cjs')
const { randomUUID } = require('node:crypto')

function createFacade({ bots, notify = () => {}, getEdition = () => 'java' }) {
  const mgr = id => typeof bots.manager === 'function' ? bots.manager(id) : bots
  const session = id => mgr(id)?.sessions?.get(id)
  const manager = id => mgr(id)
  const sessionIds = new WeakMap()
  const entityClickTimers = new Map()
  const sessionIdFor = id => { const s=session(id); if(!s)return null; if(s.sessionId)return s.sessionId; if(!sessionIds.has(s))sessionIds.set(s,randomUUID()); return sessionIds.get(s) }
  const action = async (id, args = {}, ctx = {}) => {
    if (ctx.signal?.aborted) throw err('ABORTED', 'Macro run was aborted.')
    const live = session(id)
    if (ctx.sessionId != null && sessionIdFor(id) !== ctx.sessionId) throw err('SESSION_CHANGED', 'Account session changed.')
    const online = getEdition(id)==='bedrock' ? Boolean(live?.ready&&live?.client) : Boolean(live?.bot?.entity)
    if (args.__type !== 'reconnect' && args.__type !== 'disconnect' && !online) throw err('OFFLINE', 'Account is not online.')
    if (getEdition(id) === 'bedrock' && !['chat','notify','disconnect','reconnect'].includes(args.__type)) throw err('UNSUPPORTED', 'This action requires a Java account.')
    const s = session(id); const m = manager(id); const bot = s?.bot
    try { const result = await perform(id, args, ctx, m, s, bot); if(ctx.signal?.aborted)throw err('ABORTED','Macro run was aborted.'); if(!['disconnect','reconnect'].includes(args.__type)&&ctx.sessionId!=null&&sessionIdFor(id)!==ctx.sessionId)throw err('SESSION_CHANGED','Account session changed.'); return result } catch (e) { if (e instanceof MacroActionError) throw e; if (e?.code && ['ABORTED','TIMEOUT'].includes(e.code)) throw err(e.code,e.message); throw err('INVALID', e?.message || 'Action failed.') }
  }
  const facade = {
    sessionId: id => sessionIdFor(id),
    state: id => { const s=session(id); const bedrock=getEdition(id)==='bedrock'; const t=s?.bot ? require('../bot-manager.cjs').buildTelemetry(s.bot,s.nearestChest,s.account?.environmentalMovement,s.fluidMotion) : {}; const inventory=bedrock?(s?.inventory||[]):(t.inventory||[]); const online=Boolean(bedrock?s?.ready&&s?.client:s?.bot?.entity); const occupied=new Set(inventory.map(x=>Number(x.slot))); let full=true;for(let slot=9;slot<=44;slot++)if(!occupied.has(slot)){full=false;break} return { online,sessionId:sessionIdFor(id),edition:getEdition(id),health:bedrock?s?.health:t.health,food:bedrock?s?.food:t.food,inventoryFull:online&&full,inventory:inventory.map(x=>({name:x.name,count:x.count,slot:x.slot})),windowOpen:Boolean(s?.bot?.currentWindow) } },
    chat:(id,a,c)=>action(id,{...a,__type:'chat'},c), notify:(id,a,c)=>action(id,{...a,__type:'notify'},c), move:(id,a,c)=>action(id,{...a,__type:'move'},c), look:(id,a,c)=>action(id,{...a,__type:'look'},c), control:(id,a,c)=>action(id,{...a,__type:'control'},c), leftClick:(id,a,c)=>action(id,{...a,__type:'leftClick'},c), rightClick:(id,a,c)=>action(id,{...a,__type:'rightClick'},c), selectHotbar:(id,a,c)=>action(id,{...a,__type:'selectHotbar'},c), holdItem:(id,a,c)=>action(id,{...a,__type:'holdItem'},c), useInventory:(id,a,c)=>action(id,{...a,__type:'useInventory'},c), useGui:(id,a,c)=>action(id,{...a,__type:'useGui'},c), closeGui:(id,a,c)=>action(id,{...a,__type:'closeGui'},c), waitForWindow:(id,a,c)=>action(id,{...a,__type:'waitForWindow'},c), drop:(id,a,c)=>action(id,{...a,__type:'drop'},c), dropAll:(id,a,c)=>action(id,{...a,__type:'dropAll'},c), deposit:(id,a,c)=>action(id,{...a,__type:'deposit'},c), disconnect:(id,a,c)=>action(id,{...a,__type:'disconnect'},c), reconnect:(id,a,c)=>action(id,{...a,__type:'reconnect'},c), releaseOwner:(id,owner)=>manager(id).releaseOwner?.(id,owner)
  }
  return assertFacade(facade)

  async function perform(id,a,ctx,m,s,bot) {
    const check=()=>{if(ctx.signal?.aborted)throw err('ABORTED','Macro run was aborted.');if(ctx.sessionId&&sessionIdFor(id)!==ctx.sessionId)throw err('SESSION_CHANGED','Account session changed.')}
    const locked=new Set((s?.account?.lockedInventorySlots instanceof Set?[...s.account.lockedInventorySlots]:s?.account?.lockedInventorySlots||[]).map(Number))
    const find=(selector, inventory=false)=>{const items=inventory?(bot.inventory?.items?.()||[]):(bot.currentWindow?.slots||[]).slice(0,Number(bot.currentWindow?.inventoryStart)||bot.currentWindow?.slots?.length||0).map((x,slot)=>x&&({...x,slot})).filter(Boolean);const item=items.find(x=>selector?.slot!=null?Number(x.slot)===Number(selector.slot):selector?.name?String(x.name||'').toLowerCase().includes(String(selector.name).toLowerCase()):selector?.lore?JSON.stringify(x.customLore||x.lore||'').toLowerCase().includes(String(selector.lore).toLowerCase()):false);if(!item)throw err('NOT_FOUND','Selected item or slot was not found.');return item}
    const ensureUnlocked=slot=>{if(locked.has(Number(slot)))throw err('LOCKED_SLOT',`slot ${slot} is locked`)}
    const click=async(slot,button,mode)=>{if(a.__type==='useGui'){const start=Number(bot.currentWindow?.inventoryStart)||bot.currentWindow?.slots?.length||0;if(slot>=start){const mapped=Number(bot.inventory?.inventoryStart||9)+slot-start;if(mode===1||mode===4||mode===6||button===2)ensureUnlocked(mapped);if(mode===0&&bot.currentWindow?.slots?.[slot])ensureUnlocked(mapped)} } await bot.clickWindow(slot,button,mode)}
    switch(a.__type){
      case 'chat': return m.sendChat(id,a.message)
      case 'notify': return notify({accountId:id,message:a.message,desktop:a.desktop,webhook:a.webhook,macroId:a.macroId})
      case 'control': if(!['sneak','jump','sprint'].includes(a.control))throw err('INVALID','Invalid movement control.'); if(a.action==='hold')m.claimInput(id,a.control,ctx.owner);else m.releaseInput(id,a.control,ctx.owner); return
      case 'leftClick': case 'rightClick': {const input=a.__type; if(a.action==='hold'){m.claimInput(id,input,ctx.owner);if(input==='leftClick'&&a.only==='entities'){void m.worldAction(id,'stop-dig');const key=`${id}:${ctx.owner}`;const tick=async()=>{if(!m.inputOwners(id,input).includes(ctx.owner)){entityClickTimers.delete(key);return}try{await m.worldAction(id,'attack-nearest')}catch{}if(m.inputOwners(id,input).includes(ctx.owner))entityClickTimers.set(key,setTimeout(tick,200))};entityClickTimers.set(key,setTimeout(tick,200))}return} if(a.action==='release'){const key=`${id}:${ctx.owner}`;clearTimeout(entityClickTimers.get(key));entityClickTimers.delete(key);m.releaseInput(id,input,ctx.owner);return} if(input==='leftClick'){if(a.only==='entities')return m.worldAction(id,'attack-nearest');if(a.only==='blocks')return m.worldAction(id,'dig-crosshair');try{return await m.worldAction(id,'dig-crosshair')}catch{try{return await m.worldAction(id,'attack-nearest')}catch{bot.swingArm?.('right');return { swung:true }}}} return m.worldAction(id,'use-crosshair') }
      case 'move': {const owner=ctx.owner;if(a.distance!=null)return m.worldAction(id,'walk',{control:a.control,distance:a.distance,owner,signal:ctx.signal});const duration=Number(a.durationMs);m.claimInput(id,a.control,owner);try{await abortableDelay(duration,ctx.signal);check()}finally{m.releaseInput(id,a.control,owner)}return}
      case 'look': if(a.mode==='absolute')return m.lookAbsolute(id,a.yaw,a.pitch);if(a.mode==='relative')return m.lookDelta(id,a.yaw,a.pitch);if(a.mode==='at'&&a.target==='entity'){const entity=Object.values(bot.entities||{}).find(x=>String(x.username||x.name||'').toLowerCase().includes(String(a.entity||'').toLowerCase()));if(!entity)throw err('NOT_FOUND','Target entity was not found.');return bot.lookAt(entity.position.offset(0,Number(entity.height||1)/2,0),true)}if(a.mode==='at')return m.worldAction(id,'look-at',{x:a.x,y:a.y,z:a.z});throw err('INVALID','Invalid look mode.')
      case 'selectHotbar': return m.worldAction(id,'select-hotbar',{slot:a.slot})
      case 'holdItem': {const item=find({name:a.name},true);if(item.slot<36||item.slot>44)ensureUnlocked(item.slot);return m.holdItemByName(id,a.name)}
      case 'useInventory': {const item=find(a.select,true);ensureUnlocked(item.slot);if(item.slot>=36&&item.slot<=44)bot.setQuickBarSlot(item.slot-36);const slot=item.slot;await bot.clickWindow(slot,a.click==='right'?1:0,a.click==='shift'?1:a.click==='drop'?4:0);return}
      case 'useGui': {let slot=a.select?.slot!=null?Number(a.select.slot):m.findWindowSlot(id,a.select);if(slot<0)slot=find(a.select,false).slot;const mode=a.click==='shift'?1:a.click==='drop'?4:0;return click(slot,a.click==='right'?1:0,mode)}
      case 'closeGui': return m.closeWindow(id)
      case 'waitForWindow': {const result=await waitCancelable(m.waitForWindow(id,{title:a.title,giveUpAfterMs:a.giveUpAfterMs,signal:ctx.signal}),ctx.signal);check();return result}
      case 'drop': {const item=find(a.select,true);ensureUnlocked(item.slot);return m.dropItems(id,item.slot,a.count)}
      case 'dropAll': {const matches=(bot.inventory?.items?.()||[]).filter(x=>!a.filter||String(x.name||'').toLowerCase().includes(String(a.filter).toLowerCase()));if(matches.length&&matches.every(x=>locked.has(Number(x.slot))))throw err('LOCKED_SLOT',`slot ${matches[0].slot} is locked`);return m.dropAll(id,{filter:a.filter})}
      case 'deposit': {const item=find(a.select,true);ensureUnlocked(item.slot);return m.depositSlot(id,item.slot,a.count)}
      case 'disconnect': return m.disconnect(id)
      case 'reconnect': {m.disconnect(id);await abortableDelay(a.delayMs||0,ctx.signal);if(ctx.signal?.aborted)throw err('ABORTED','Macro run was aborted.');const account=s?.account||m.reconnects?.get(id)?.account;if(!account)throw err('OFFLINE','Account configuration unavailable.');return m.connect(account)}
    }
  }
}
function err(code,message){return new MacroActionError(code,message)}
function abortableDelay(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(err('ABORTED','Macro run was aborted.'));const t=setTimeout(done,Math.max(0,Number(ms)||0));function done(){signal?.removeEventListener('abort',abort);resolve()}function abort(){clearTimeout(t);reject(err('ABORTED','Macro run was aborted.'))}signal?.addEventListener('abort',abort,{once:true})})}
function waitCancelable(p,signal){if(!signal)return p;return Promise.race([p,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(err('ABORTED','Macro run was aborted.')),{once:true}))])}
module.exports={createFacade}
