require("dotenv").config();
const express = require("express");
const {Bot, InlineKeyboard} = require("grammy");
const {createClient} = require("@supabase/supabase-js");
const {TelegramClient, Api} = require("telegram");
const {StringSession} = require("telegram/sessions");

const A = new Set((process.env.ADMIN_IDS||"").split(",").map(x=>x.trim()).filter(Boolean));
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const bot = new Bot(process.env.BOT_TOKEN);
const clients = new Map(), flows = new Map(), timers = new Map();

const adminKB = {keyboard:[
  [{text:"➕ Add User via ID"},{text:"👥 Total User"}],
  [{text:"🟢 User Aktif"},{text:"🔌 Putuskan Bot User"}]
],resize_keyboard:true};
const userKB = {keyboard:[
  [{text:"➕ Add Group"},{text:"⏱ Set Jeda"}],
  [{text:"📅 Set Hari"},{text:"📝 Send Format Promosi"}],
  [{text:"▶️ Mulai"},{text:"⏹ Stop"}],
  [{text:"🔐 Login/Kaitkan Akun"}]
],resize_keyboard:true};

const admin = id=>A.has(String(id));
async function user(tg){
  const {data}=await sb.from("app_users").select("*").eq("telegram_user_id",tg).maybeSingle();
  return data;
}
async function active(ctx){
  const u=await user(ctx.from.id);
  if(!u || u.status!=="active"){await ctx.reply("❌ Kamu belum diaktifkan admin.");return null;}
  return u;
}
function secs(s){
  const m=String(s).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(detik|menit|jam|hari|s|m|h|d)$/);
  if(!m)return null;
  return Math.round(Number(m[1])*({detik:1,s:1,menit:60,m:60,jam:3600,h:3600,hari:86400,d:86400}[m[2]]));
}
async function clientFor(u){
  if(clients.has(u.id)) return clients.get(u.id);
  const {data}=await sb.from("telegram_sessions").select("*").eq("user_id",u.id).maybeSingle();
  if(!data?.session_string)return null;
  const c=new TelegramClient(new StringSession(data.session_string),Number(process.env.API_ID),process.env.API_HASH,{connectionRetries:5});
  await c.connect();
  if(!(await c.checkAuthorization()))return null;
  clients.set(u.id,c); return c;
}
async function groups(u){
  const c=await clientFor(u); if(!c)throw Error("Akun Telegram belum login.");
  const ds=await c.getDialogs({limit:100}), rows=[];
  for(const d of ds){
    if(!d.isGroup && !d.isChannel)continue;
    let can=true;
    if(d.entity?.className==="Channel"){
      try{
        const me=await c.getEntity("me");
        const p=await c.invoke(new Api.channels.GetParticipant({channel:d.entity,userId:me}));
        can=["ChannelParticipantCreator","ChannelParticipantAdmin"].includes(p.participant?.className);
      }catch{can=false;}
    }
    rows.push({user_id:u.id,telegram_group_id:String(d.entity.id?.value??d.entity.id),
      title:d.title||"Unnamed",can_send:can});
  }
  if(rows.length)await sb.from("groups").upsert(rows,{onConflict:"user_id,telegram_group_id"});
  return rows;
}
async function fire(id){
  const {data:c}=await sb.from("campaigns").select("*").eq("id",id).single();
  if(!c||c.status!=="running")return;
  if(new Date(c.expires_at)<=new Date()){
    await sb.from("campaigns").update({status:"expired"}).eq("id",id); return;
  }
  const {data:u}=await sb.from("app_users").select("*").eq("id",c.user_id).single();
  const cl=await clientFor(u); if(!cl)return;
  const {data:links}=await sb.from("campaign_groups").select("group_id,groups(*)").eq("campaign_id",id);
  for(const x of links||[]){
    const g=x.groups;
    if(!g?.enabled||!g.can_send)continue;
    try{
      await cl.sendMessage(g.telegram_group_id,{message:c.message});
      await sb.from("send_logs").insert({campaign_id:id,user_id:c.user_id,group_id:g.id,status:"sent"});
    }catch(e){
      await sb.from("send_logs").insert({campaign_id:id,user_id:c.user_id,group_id:g.id,status:"error",error:String(e).slice(0,1000)});
    }
  }
}
function schedule(id,delay=0){
  if(timers.has(id))clearTimeout(timers.get(id));
  timers.set(id,setTimeout(async()=>{
    await fire(id);
    const {data}=await sb.from("campaigns").select("status,interval_seconds,expires_at").eq("id",id).maybeSingle();
    if(data?.status==="running"&&new Date(data.expires_at)>new Date())
      schedule(id,Number(data.interval_seconds)*1000);
    else timers.delete(id);
  },delay));
}

bot.command("start",async ctx=>{
  if(admin(ctx.from.id))return ctx.reply("🛠 Admin Dashboard",{reply_markup:adminKB});
  const u=await user(ctx.from.id);
  if(u?.status==="active")return ctx.reply("👤 Menu User",{reply_markup:userKB});
  ctx.reply("Kirim Telegram ID kamu ke admin.");
});

bot.hears("➕ Add User via ID",async ctx=>{
  if(!admin(ctx.from.id))return;
  flows.set(ctx.from.id,{t:"add"});ctx.reply("Kirim numeric Telegram ID user.");
});
bot.hears("👥 Total User",async ctx=>{
  if(!admin(ctx.from.id))return;
  const {count}=await sb.from("app_users").select("*",{count:"exact",head:true});
  ctx.reply(`👥 Total user: ${count||0}`);
});
bot.hears("🟢 User Aktif",async ctx=>{
  if(!admin(ctx.from.id))return;
  const {data}=await sb.from("app_users").select("*").eq("status","active");
  ctx.reply(data?.length?data.map((x,i)=>`${i+1}. ${x.first_name||"-"} | ${x.telegram_user_id}`).join("\n"):"Belum ada user aktif.");
});
bot.hears("🔌 Putuskan Bot User",async ctx=>{
  if(!admin(ctx.from.id))return;
  flows.set(ctx.from.id,{t:"disconnect"});ctx.reply("Kirim Telegram ID user.");
});

bot.hears("➕ Add Group",async ctx=>{
  const u=await active(ctx);if(!u)return;
  try{
    await groups(u);
    const {data}=await sb.from("groups").select("*").eq("user_id",u.id).eq("can_send",true).order("title");
    if(!data?.length)return ctx.reply("Tidak ada grup yang terdeteksi bisa dikirimi pesan.");
    flows.set(ctx.from.id,{t:"groups",list:data});
    ctx.reply("Ketik nomor grup yang diaktifkan, contoh: 1,3\n\n"+data.map((g,i)=>`${i+1}. ${g.title}`).join("\n"));
  }catch(e){ctx.reply("❌ "+e.message)}
});
bot.hears("⏱ Set Jeda",async ctx=>{const u=await active(ctx);if(!u)return;flows.set(ctx.from.id,{t:"interval"});ctx.reply("Contoh: 1 jam, 30 menit, 10 detik.");});
bot.hears("📅 Set Hari",async ctx=>{const u=await active(ctx);if(!u)return;const {data}=await sb.from("campaigns").select("*").eq("user_id",u.id).order("created_at",{ascending:false}).limit(1);if(!data?.[0])return ctx.reply("Buat format promosi dulu.");flows.set(ctx.from.id,{t:"duration",id:data[0].id});ctx.reply("Contoh: 3 hari.");});
bot.hears("📝 Send Format Promosi",async ctx=>{const u=await active(ctx);if(!u)return;flows.set(ctx.from.id,{t:"message"});ctx.reply("Kirim teks promosi.");});
bot.hears("▶️ Mulai",async ctx=>{
  const u=await active(ctx);if(!u)return;
  const {data}=await sb.from("campaigns").select("*").eq("user_id",u.id).order("created_at",{ascending:false}).limit(1);
  const c=data?.[0];if(!c)return ctx.reply("❌ Belum ada format promosi.");
  const {data:gs}=await sb.from("groups").select("id").eq("user_id",u.id).eq("enabled",true).eq("can_send",true);
  if(!gs?.length)return ctx.reply("❌ Belum ada grup aktif.");
  const now=new Date(),exp=new Date(now.getTime()+Number(c.duration_seconds)*1000);
  await sb.from("campaign_groups").delete().eq("campaign_id",c.id);
  await sb.from("campaign_groups").insert(gs.map(g=>({campaign_id:c.id,group_id:g.id})));
  await sb.from("campaigns").update({status:"running",started_at:now.toISOString(),expires_at:exp.toISOString()}).eq("id",c.id);
  schedule(c.id,0);ctx.reply("▶️ Campaign dimulai.");
});
bot.hears("⏹ Stop",async ctx=>{
  const u=await active(ctx);if(!u)return;
  const {data}=await sb.from("campaigns").select("id").eq("user_id",u.id).eq("status","running");
  for(const c of data||[]){if(timers.has(c.id))clearTimeout(timers.get(c.id));timers.delete(c.id);await sb.from("campaigns").update({status:"stopped"}).eq("id",c.id);}
  ctx.reply("⏹ Campaign dihentikan.");
});
bot.hears("🔐 Login/Kaitkan Akun",async ctx=>{
  const u=await active(ctx);if(!u)return;
  flows.set(ctx.from.id,{t:"phone"});ctx.reply("Kirim nomor Telegram, contoh +628123456789.");
});

bot.on("message:text",async ctx=>{
  const f=flows.get(ctx.from.id), t=ctx.message.text.trim();
  if(!f)return;
  if(admin(ctx.from.id)&&f.t==="add"){
    const id=Number(t);if(!Number.isSafeInteger(id))return ctx.reply("❌ ID tidak valid.");
    await sb.from("app_users").upsert({telegram_user_id:id,status:"active"},{onConflict:"telegram_user_id"});
    flows.delete(ctx.from.id);return ctx.reply("✅ User ditambahkan.",{reply_markup:adminKB});
  }
  if(admin(ctx.from.id)&&f.t==="disconnect"){
    const id=Number(t),u=await user(id);if(!u)return ctx.reply("❌ User tidak ditemukan.");
    const c=clients.get(u.id);if(c)try{await c.disconnect()}catch{}clients.delete(u.id);
    await sb.from("telegram_sessions").update({status:"disconnected"}).eq("user_id",u.id);
    await sb.from("app_users").update({status:"disabled"}).eq("id",u.id);
    flows.delete(ctx.from.id);return ctx.reply("✅ User diputuskan.",{reply_markup:adminKB});
  }
  const u=await active(ctx);if(!u)return;
  if(f.t==="groups"){
    const nums=t.split(",").map(x=>Number(x.trim())-1).filter(i=>Number.isInteger(i)&&i>=0&&i<f.list.length);
    await sb.from("groups").update({enabled:false}).eq("user_id",u.id);
    for(const i of nums)await sb.from("groups").update({enabled:true}).eq("id",f.list[i].id);
    flows.delete(ctx.from.id);return ctx.reply("✅ Grup aktif diperbarui.");
  }
  if(f.t==="message"){
    const {data:c,error}=await sb.from("campaigns").insert({user_id:u.id,message:t}).select().single();
    flows.delete(ctx.from.id);return ctx.reply(error?"❌ Gagal menyimpan.":"✅ Format promosi tersimpan.");
  }
  if(f.t==="interval"){
    const s=secs(t);if(!s||s<10)return ctx.reply("❌ Format tidak valid. Minimal 10 detik.");
    const {data:c}=await sb.from("campaigns").select("id").eq("user_id",u.id).order("created_at",{ascending:false}).limit(1);
    if(!c?.[0])return ctx.reply("Buat format promosi dulu.");
    await sb.from("campaigns").update({interval_seconds:s}).eq("id",c[0].id);
    flows.delete(ctx.from.id);return ctx.reply("✅ Jeda disimpan.");
  }
  if(f.t==="duration"){
    const s=secs(t);if(!s)return ctx.reply("❌ Contoh: 3 hari.");
    await sb.from("campaigns").update({duration_seconds:s}).eq("id",f.id);
    flows.delete(ctx.from.id);return ctx.reply("✅ Durasi disimpan.");
  }
  if(f.t==="phone"){
    try{
      const c=new TelegramClient(new StringSession(""),Number(process.env.API_ID),process.env.API_HASH,{connectionRetries:5});
      await c.start({phoneNumber:async()=>t,phoneCode:async()=>{flows.set(ctx.from.id,{t:"code",c,u,phone:t});return (await bot.api.sendMessage(ctx.from.id,"Masukkan kode login Telegram yang baru diterima:")).text;}});
      await sb.from("telegram_sessions").upsert({user_id:u.id,session_string:c.session.save(),status:"connected",phone:t});
      clients.set(u.id,c);flows.delete(ctx.from.id);return ctx.reply("✅ Akun Telegram berhasil dikaitkan.",{reply_markup:userKB});
    }catch(e){return ctx.reply("❌ Login gagal: "+String(e.message||e).slice(0,500));}
  }
});
bot.catch(e=>console.error(e.error));
(async()=>{
  const {data}=await sb.from("campaigns").select("id").eq("status","running");
  for(const c of data||[])schedule(c.id,0);
  await bot.start();console.log("Bot started");
})();
const app=express();app.get("/",(_,r)=>r.json({ok:true}));app.listen(Number(process.env.PORT||3000));
