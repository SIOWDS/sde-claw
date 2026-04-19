import React, { useState, useEffect, useRef, useCallback } from "react";
import * as mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";

// Configure pdfjs worker (must point to a valid worker URL)
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).toString();
}

// ═══════════════════════════════════════════════════════════════════
// window.storage polyfill (for Claude artifact sandbox API compatibility)
// Originally designed for Claude artifact's window.storage API;
// here we reimplement on top of browser localStorage so it runs anywhere.
// ═══════════════════════════════════════════════════════════════════
if (typeof window !== "undefined" && !window.storage) {
  // Detect if localStorage is actually available (private mode in Safari disables it)
  let lsAvailable = false;
  try {
    const testKey = "__sdeclaw_test__";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    lsAvailable = true;
  } catch (e) {
    console.warn("localStorage unavailable — using in-memory fallback. Data will not persist across reload.");
  }

  // In-memory fallback Map for when localStorage is unavailable
  const memStore = new Map();

  window.storage = {
    async set(key, value) {
      try {
        const v = typeof value === "string" ? value : JSON.stringify(value);
        if (lsAvailable) {
          localStorage.setItem(key, v);
        } else {
          memStore.set(key, v);
        }
        return { key, value };
      } catch (e) {
        // QuotaExceededError: browser storage full (5MB limit)
        console.error("storage.set failed:", e.message);
        // Fall back to memory store so the app doesn't crash
        try {
          memStore.set(key, typeof value === "string" ? value : JSON.stringify(value));
          return { key, value };
        } catch (e2) {
          throw e;
        }
      }
    },
    async get(key) {
      try {
        const v = lsAvailable ? localStorage.getItem(key) : (memStore.get(key) ?? null);
        if (v === null || v === undefined) return null;
        return { key, value: v };
      } catch (e) {
        console.error("storage.get failed:", e.message);
        return null;
      }
    },
    async delete(key) {
      try {
        if (lsAvailable) localStorage.removeItem(key);
        memStore.delete(key);
        return { key, deleted: true };
      } catch (e) {
        console.error("storage.delete failed:", e.message);
        return { key, deleted: false };
      }
    },
    async list(prefix = "") {
      try {
        const keys = [];
        if (lsAvailable) {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(prefix)) keys.push(k);
          }
        } else {
          for (const k of memStore.keys()) {
            if (k.startsWith(prefix)) keys.push(k);
          }
        }
        return { keys, prefix };
      } catch (e) {
        console.error("storage.list failed:", e.message);
        return { keys: [], prefix };
      }
    },
  };
}

// ═══ File parsing ═══
function stripHtml(html){
  // Remove style/script tags and their content first
  let clean=html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,"")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,"")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi,"");
  // Convert common block elements to newlines
  clean=clean.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi,"\n")
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/(td|th)>/gi," | ")
    .replace(/<hr[^>]*>/gi,"\n---\n");
  // Strip all remaining tags
  clean=clean.replace(/<[^>]+>/g,"");
  // Decode HTML entities
  clean=clean.replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#(\d+);/g,(m,c)=>String.fromCharCode(c));
  // Clean up whitespace
  clean=clean.replace(/[ \t]+/g," ").replace(/\n[ \t]+/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  return clean;
}

function cleanFileText(text){
  if(!text)return text;
  // Detect if content is HTML or contains HTML/CSS artifacts
  if(text.includes("<html")||text.includes("<body")||text.includes("<style")||text.includes("<div ")||text.includes("<p ")||text.includes("<h1")||text.includes("<h2")||text.includes("xmlns:")||text.match(/@page\s*\{/)){
    return stripHtml(text);
  }
  return text;
}

async function readFileAsText(file){
  const ext=(file.name||"").split(".").pop().toLowerCase();
  const readBuf=()=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(new Error("Read failed"));r.readAsArrayBuffer(file);});
  const readTxt=()=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(new Error("Read failed"));r.readAsText(file);});
  const readB64=()=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result.split(",")[1]);r.onerror=()=>rej(new Error("Read failed"));r.readAsDataURL(file);});

  if(ext==="txt"||ext==="md"){const t=await readTxt();return cleanFileText(t);}

  if(ext==="docx"||ext==="doc"){
    // Try mammoth (works for docx, sometimes for doc)
    try{const buf=await readBuf();const result=await mammoth.extractRawText({arrayBuffer:buf});if(result.value&&result.value.trim().length>20)return cleanFileText(result.value);}
    catch(e){/* fall through */}
    // For .doc: try reading as text and extracting readable content
    try{
      const raw=await readTxt();
      // Strip HTML if the .doc is actually HTML-based
      const stripped=cleanFileText(raw);
      if(stripped.trim().length>50)return stripped.trim();
      // Also try extracting from binary content
      const cleaned=raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g,"").replace(/[^\S\n]+/g," ").split("\n").filter(l=>l.trim().length>3&&/[a-zA-Z\u4e00-\u9fff]{2,}/.test(l)).join("\n");
      if(cleaned.trim().length>50)return cleaned.trim();
    }catch(e){/* fall through */}
    // Last resort: give up on legacy .doc and guide user
    return "[Could not read .doc file. Please save as .docx or copy-paste text.]";
  }

  if(ext==="pdf"){
    // Pure front-end PDF parsing via pdfjs-dist
    try{
      const buf=await readBuf();
      const pdf=await pdfjsLib.getDocument({data:buf}).promise;
      let fullText="";
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i);
        const content=await page.getTextContent();
        const pageText=content.items.map(it=>it.str||"").join(" ");
        fullText+=pageText+"\n\n";
      }
      const clean=fullText.trim();
      if(clean.length>20)return cleanFileText(clean);
      return "[PDF appears to be scanned/image-based. Please OCR first or paste text manually.]";
    }catch(e){
      return "[PDF reading failed: "+(e.message||"unknown error")+". Please copy-paste text manually.]";
    }
  }

  return "[Unsupported format: ."+ext+". Use PDF, DOCX, DOC, TXT, or paste text.]";
}

// ═══════════════════════════════════════════════════════════════════
// File-size / content limits (for the multi-paper input feature)
// DeepSeek V3.2 context window is 128K tokens ≈ 95k Chinese chars
// We reserve ~50% for prompts/output, so usable content budget ≈ 50K chars
// ═══════════════════════════════════════════════════════════════════
const FILE_LIMITS = {
  SAFE_CHARS: 200000,     // 🟢 单篇字数安全上限(放开至 20 万字,支持整本书章节级长文)
  WARN_CHARS: 400000,     // 🟡 超过 40 万字才警告
  SAFE_SIZE_MB: 25,       // 🟢 文件大小安全(放宽到 25MB)
  WARN_SIZE_MB: 40,       // 🟡 警告
  HARD_SIZE_MB: 80,       // 🔴 硬上限(拒绝) — 80MB 能吞几乎任何合理 PDF
  SAFE_PAGES: 400,        // 🟢 PDF 页数安全(放宽到 400 页,整本专著)
  WARN_PAGES: 800,        // 🟡 警告
  PER_PAPER_SENT: 200000, // 每篇发给 AI 精读的字符上限 — 20 万字充分利用 Gemini 2M 窗口
  TOTAL_BUDGET: 4000000,  // 总上限:20 篇 × 20 万字 = 400 万字(Gemini Pro 2M tokens 的 80% 利用率)
};

function getFileLevel(meta) {
  // Returns "safe" | "warn" | "over"
  if (!meta) return "unknown";
  if (meta.sizeMB > FILE_LIMITS.HARD_SIZE_MB) return "over";
  if (meta.chars > FILE_LIMITS.WARN_CHARS || meta.sizeMB > FILE_LIMITS.WARN_SIZE_MB || (meta.pages && meta.pages > FILE_LIMITS.WARN_PAGES)) return "over";
  if (meta.chars > FILE_LIMITS.SAFE_CHARS || meta.sizeMB > FILE_LIMITS.SAFE_SIZE_MB || (meta.pages && meta.pages > FILE_LIMITS.SAFE_PAGES)) return "warn";
  return "safe";
}

function getLevelBadge(level) {
  if (level === "safe") return { icon: "🟢", color: "#10b981", label: "safe" };
  if (level === "warn") return { icon: "🟡", color: "#f59e0b", label: "warn" };
  if (level === "over") return { icon: "🔴", color: "#ef4444", label: "over" };
  return { icon: "⚪", color: "#6b7280", label: "unknown" };
}

// Enhanced wrapper: returns both content and metadata (sizeMB, pages, chars, level, sentChars)
// Backward compatible: existing callers of readFileAsText(file) still work
async function readFileAsTextMeta(file) {
  const sizeMB = +(file.size / 1024 / 1024).toFixed(2);
  const ext = (file.name || "").split(".").pop().toLowerCase();
  let pages = null;

  // Hard size gate
  if (sizeMB > FILE_LIMITS.HARD_SIZE_MB) {
    return {
      content: `[File exceeds ${FILE_LIMITS.HARD_SIZE_MB}MB hard limit: ${sizeMB}MB]`,
      meta: { sizeMB, pages: null, chars: 0, sentChars: 0, level: "over", reason: `超过 ${FILE_LIMITS.HARD_SIZE_MB}MB 硬上限` }
    };
  }

  // Count PDF pages if applicable (before extracting text — cheap)
  if (ext === "pdf") {
    try {
      const buf = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("Read failed")); r.readAsArrayBuffer(file);
      });
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      pages = pdf.numPages;
      let fullText = "";
      for (let i = 1; i <= pages; i++) {
        const page = await pdf.getPage(i);
        const pc = await page.getTextContent();
        fullText += pc.items.map(it => it.str || "").join(" ") + "\n\n";
      }
      const clean = fullText.trim();
      const content = clean.length > 20 ? cleanFileText(clean) : "[PDF appears to be scanned/image-based. Please OCR first or paste text manually.]";
      const chars = content.startsWith("[") ? 0 : content.length;
      const sentChars = Math.min(chars, FILE_LIMITS.PER_PAPER_SENT);
      const level = getFileLevel({ sizeMB, pages, chars });
      return {
        content,
        meta: { sizeMB, pages, chars, sentChars, level, reason: content.startsWith("[") ? "扫描版,无法提取文字" : null }
      };
    } catch (e) {
      return {
        content: "[PDF reading failed: " + (e.message || "unknown") + ". Please copy-paste text manually.]",
        meta: { sizeMB, pages, chars: 0, sentChars: 0, level: "over", reason: "PDF 读取失败" }
      };
    }
  }

  // Other file types: reuse the legacy extractor
  const content = await readFileAsText(file);
  const isError = content.startsWith("[");
  const chars = isError ? 0 : content.length;
  const sentChars = Math.min(chars, FILE_LIMITS.PER_PAPER_SENT);
  const level = isError ? "over" : getFileLevel({ sizeMB, pages: null, chars });
  return {
    content,
    meta: { sizeMB, pages: null, chars, sentChars, level, reason: isError ? content.slice(1, 60) : null }
  };
}

// ═══════════════════════════════════════════════════════════════════
// 龙爪手创新宪法 · 平台永久记忆 (v1.1 扩编版)
// Innovation Constitution - Permanent Knowledge Base
// Source: 《龙爪手：以SDE本体论为指导的知识创新原理》王德生著（扩编版·34编）
// ═══════════════════════════════════════════════════════════════════
const CONSTITUTION = {
  version:"1.1-expanded",
  editions:"5编23章→34编（含深度论题篇·工具篇）",
  totalFormula:"以SDE本体论为思想指导，对旧思想进行裂缝扫描，以新概念发明完成建构性填补，使解构与建构形成连续运行。",
  motto:"SDE看见整棵文明知识树如何发生，龙爪手负责发现并填补这棵树上的缝。",
  // ─── 十六条纲条 ───
  articles:[
    {id:1,name:"发生体原理",ch:"第一章",core:"知识不是静态客体，而是可抓取、可组织、可锻造的发生体。知识总是处于潜伏、显影、固化、传播、变形、死亡与重生的连续过程中。一切知识创新活动的起点，是承认知识的发生性而非完成性。",maxim:"知识不是静物，而是一个在纠缠条件中等待被高阶抓取的发生体。谁只看见成形之物，谁就只能复述；谁能感知潜伏之物，谁就开始锻造。"},
    {id:2,name:"裂缝第一原理",ch:"第三章",core:"一切创新始于对尚未被旧语言充分命名的裂缝的高敏感抓取。裂缝不是知识秩序中的瑕疵，而是新知识秩序即将诞生的产道。",maxim:"裂缝不是知识秩序中的瑕疵，而是新知识秩序即将诞生的产道。谁把裂缝当成麻烦，谁就不断修补过去；谁把裂缝当成入口，谁就开始制造未来。"},
    {id:3,name:"随机创新上限原理",ch:"第二章",core:"随机创新是原料不是成品，是野矿不是兵器，是胚胎不是系统。龙爪手的任务是为随机创新安装骨架、轨道与供能系统。火花的价值在于打开，火炉的价值在于持续供能与熔炼。",maxim:"随机创新是火花，不是火炉。火花的任务是点燃，龙爪手的任务是建炉、供能与冶炼。"},
    {id:4,name:"六爪完整性原则",ch:"第六章",core:"抓核、抓裂缝、重组、改姓、锻造、投放六爪必须连续咬合，任何一爪的缺失都使创新停在半成品阶段。六爪不是六个技巧的松散罗列，而是一套互相预设、互相倒逼的动作学系统。",maxim:"六爪不是六个技巧，而是一条不可断裂的知识锻造链。断一爪则废全链，回一环则精全器。"},
    {id:5,name:"去母体化原则",ch:"第十章",core:"内部发生属于母体，外部成品必须属于战场。改姓在灵感发生时完成，不在终稿修改时完成。",maxim:"母体的最高境界，不是被不断引用，而是让子代忘记它的名字却继续携带它的火。"},
    {id:6,name:"武器锻造五律",ch:"第十章",core:"一、不写SDE。二、内部引擎only。三、即时改名。四、独立自洽。五、学科本地人测试。凡成品中仍大量可见母体术语者，皆为违反本条。",maxim:"改姓不是削弱原创性，而是原创性成熟的标志。"},
    {id:7,name:"大概念六判准",ch:"第四章",core:"能生成新问题空间，能跨场景维持自身，能长出方法论，能改写旧边界，能持续锻造自身，能完成学科改姓。凡只能在母体内部高喊口号而无法进入他者内部生根者，不配称大概念。",maxim:"大概念不是大在声量，而是大在迁移力、定居力与持续锻造力。能开问题大陆者，才配称大概念。"},
    {id:8,name:"纠缠条件原理",ch:"第五章",core:"知识创新不是孤立的概念爆发，而是在历史条件、技术条件、学科条件、语词条件、问题条件与主体经验条件构成的纠缠网络中被催生。概念之所以值得被抓，不仅因为它听起来新，还因为它处在一个足以支撑其继续生长的纠缠网络之中。",maxim:"概念的生长力不仅取决于它自身的新颖度，更取决于它所扎入的纠缠网络的密度与深度。抓核先抓网，网密核自长。"},
    {id:9,name:"复合创新体原则",ch:"第十七章",core:"人负责主导性问题空间与抓核定向，AI负责高频生成与变体试探，双方共同完成长程锻造。人在复合体中提供的不只是最后审核，而是一整套深层牵引。",maxim:"人在复合体中的角色不是纠错器，而是执念提供者。"},
    {id:10,name:"三模型分工宪章",ch:"第二十二章",core:"E1(Gemini)为现实数据智能，E2(Claude)为推理智能/六爪主执行者，E3(GPT)为纠缠联想智能。三模型经三角互消后自然去AI化。",maxim:"E1供料，E2筛锻，E3试探，三角互消自然去AI化。人持最高裁决权，方向永远属于人。"},
    {id:11,name:"解构-建构连续运行原理",ch:"第六章/结语",core:"纯批判只会让壳破裂，纯创造可能与真实裂缝脱节。解构与建构必须形成不间断的连续运行。",maxim:"龙爪手不是纯批判，也不是纯发明，而是解构与建构的连续运行。"},
    {id:12,name:"零拷贝宪法",ch:"第二十章",core:"全程零拷贝，一键流转。SDE-Claw平台模块间一切数据转移通过按钮点击完成，不允许手动复制粘贴。",maxim:"凡需要用户在模块之间手动搬运数据者，皆为平台设计缺陷。"},
    {id:13,name:"断链诊断原则",ch:"第十二章",core:"六爪链条在任何一爪处断裂，都会产生可辨认的症状。平台必须内置断链诊断机制，自动识别停滞位置并给出修复路径。",maxim:"创新停滞的真正原因，几乎从来不在创新者以为的那个位置。"},
    {id:14,name:"违宪判断标准",ch:"第二十一章",core:"跳过裂缝扫描直接改良=违反第2条。随机输出直接当成品=违反第3条。成品未通过本地人测试即投放=违反第6条。人完全放弃问题主导权=违反第9条。",maxim:"违宪行为分三级：红色(能力退化)、橙色(成品不完整)、黄色(流程效率降低)。"},
    {id:15,name:"修宪原则",ch:"第二十三章",core:"本宪法自身亦须接受裂缝第一原理的检验。修宪须经完整六爪流程。宪法版本号随每次修宪递增。",maxim:"一部不敢对自己开刀的宪法，配不上'裂缝第一'的名号。"},
    {id:16,name:"123原理",ch:"第三十四编",core:"SDE体系中任何三元组的三者之间存在非线性函数关系：S=H(D,E)，D=G(S,E)，E=F(S,D)。三者互生，无第一因，无先验项。123原理的定义边界不可过度扩展。全息学、万域建构引擎、矛盾诊断、龙爪手工程化、权力理论均为其应用推论，不是123原理本身。",maxim:"123原理本身就是那三条非线性函数关系，不多，不少。本宪法前十五条纲条中涉及三元结构之处，其底层运算规则均可溯源至此条函数关系。"},
  ],
  // ─── 123原理 · 三元非线性函数关系 ───
  principle123:{
    definition:"S=H(D,E), D=G(S,E), E=F(S,D) — 三者互生，无第一因，无先验项",
    operationRules:[
      {name:"反孤立原则",rule:"任一维的求解需要另外两维作为输入。理解A必须同时考察B和C对A的联合作用。"},
      {name:"联动原则",rule:"改变任一维必然同时改变另外两维。A的改变自动触发B和C的重新计算。"},
      {name:"建构原则",rule:"从已有维度出发，可以推导另外两维的可能形态。这是万域建构引擎的操作基础。"},
      {name:"迭代收敛原则",rule:"A₀→B₁=F₂(A₀,C₀)→C₁=F₃(A₀,B₁)→A₁=F₁(B₁,C₁)...多轮迭代趋向更高阶稳态。"},
    ],
    holographicLayers:[
      {layer:"S-D-E顶层",triad:"S/D/E",formula:"S=H(D,E), D=G(S,E), E=F(S,D)"},
      {layer:"SIO层",triad:"主体/互动/客体",formula:"S=H(I,O), I=G(S,O), O=F(S,I)"},
      {layer:"模态层",triad:"粒子/波/场",formula:"粒子=H(波,场), 波=G(粒子,场), 场=F(粒子,波)"},
      {layer:"规范层",triad:"对比/变化/分布",formula:"对比=H(变化,分布), 变化=G(对比,分布), 分布=F(对比,变化)"},
      {layer:"价值层",triad:"真/善/美",formula:"真=H(善,美), 善=G(真,美), 美=F(真,善)"},
      {layer:"三界层",triad:"现实/理念/自我",formula:"现实=H(理念,自我), 理念=G(现实,自我), 自我=F(现实,理念)"},
      {layer:"意义层",triad:"创造/自由/幸福",formula:"创造=H(自由,幸福), 自由=G(创造,幸福), 幸福=F(创造,自由)"},
    ],
    dynamics:{
      mature:"三个函数H/G/F的输出互相支撑，系统处于稳定的正反馈循环中",
      degenerate:"某个函数的参数偏移，导致互生循环断裂，系统开始塌缩",
      recombine:"旧的函数关系解体，新的函数关系尚在建立，系统处于混沌-介生态",
    },
    applicationDeductions:[
      {name:"全息推论",desc:"123关系不仅在S-D-E顶层运作，在每一个三元组内部都同时运作——局部是整体的全息投影"},
      {name:"建构推论",desc:"从函数关系出发可推导新概念、新流程、新结构"},
      {name:"诊断推论",desc:"三元中缺一则函数不可解，矛盾必然产生"},
      {name:"工程推论",desc:"龙爪手六爪动作链是这条函数关系的序列化展开，零拷贝宪法是函数链完整性的工程保障"},
      {name:"经济推论",desc:"跨域运作降低每轮函数运算的信息成本"},
    ],
    boundaryWarning:"123原理仅讲述三元之间的非线性函数关系。全息学/万域建构引擎/矛盾诊断/龙爪手工程化/权力理论均为应用推论，不是123原理本身。不可过度扩展其定义边界。",
  },
  // ─── 六爪动作链 ───
  sixClaws:[
    {id:1,name:"抓核",en:"Core Capture",icon:"🎯",
     def:"从混杂材料中抓住真正具有生长力的核心概念胚胎",
     criteria:["生长性：是否有后劲？能否跨场景维持？","差异性：与旧系统是表层修辞差异还是深层结构差异？","纠缠密度：周围是否有足够历史、工具、学科和问题支撑？"],
     sde:"主要在S维度——识别半显影结构；D维度判断新差异轨迹；E作为评估背景",
     errors:["抓响不抓核","抓多不抓一","抓旧当抓新","抓大当抓好","抓外当抓内","抓感当抓理","抓一次就不再抓","抓别人核当自己核","抓核不检查纠缠","对核有迷恋不愿换"],
     timeRatio:3},
    {id:2,name:"抓裂缝",en:"Fracture Detection",icon:"🔍",
     def:"识别旧系统在哪些边界上开始失去解释力、组织力、投放力和生长力",
     criteria:["四追问：旧语言何处笨重？旧方法何处失效？旧框架内部何处矛盾？旧房角石是否仍可靠？"],
     sde:"主要在S维度退化端；D维度提供诊断(新旧差异失配)；E帮助判断可操作性",
     fourDepths:["表层裂缝(术语)：旧术语描述新现象时笨重绕远","概念裂缝(方法)：旧方法处理新数据时效率低、解释不稳","框架裂缝(结构)：旧框架核心部分互相挤压、无法共存","本体裂缝(范式)：学科默认的房角石开始不再可靠"],
     timeRatio:4},
    {id:3,name:"重组",en:"Recombination",icon:"🔄",
     def:"在更高层级重新组织材料间的吸引关系与排斥关系，让新秩序诞生",
     criteria:["成功标准：让一批散乱材料突然变得'不得不一起被看'","让复杂性获得新的可读性"],
     sde:"主要在D维度——建立新差异序列；S处于半显影态；E提供重组原材料",
     timeRatio:1},
    {id:4,name:"改姓",en:"Renaming/Disciplinary Translation",icon:"📛",
     def:"让新秩序在目标学科中获得本地身份，从母体语言转写为学科本地语言",
     criteria:["先获本地身份","保留深层机制换表层壳","通过学科本地人测试","允许不同版本"],
     sde:"主要在E维度——从母体纠缠网络切换到目标学科纠缠网络；S发生表层壳替换",
     linguisticNote:"改姓不只是换术语，还需进入目标学科的'概念语法'——论文的开头方式、论证节奏、证据标准、措辞规范",
     timeRatio:2},
    {id:5,name:"锻造",en:"Forging",icon:"🔨",
     def:"补齐论证链、建立边界、设计例子、处理反对意见、确定适用与失效条件",
     criteria:["打定义","打论证链","打反对意见","打例子","打方法","打失效条件"],
     sde:"主要在S维度固化端；D用于测试边界；E提供火源(反对意见、应用测试)",
     timeRatio:5},
    {id:6,name:"投放",en:"Deployment",icon:"🚀",
     def:"让成果进入具体学科、实践、评审机制和传播网络中接受检验",
     criteria:["选择战场","多形态投放","投放后必须回环(反馈→新一轮裂缝扫描)"],
     sde:"主要在E维度——进入新纠缠网络；D观测是否产生新差异推进",
     battlefields:["A类:顶刊","B类:专业期刊","C类:学术专著","D类:教育应用","E类:产业应用"],
     timeRatio:1},
  ],
  // ─── 武器锻造五律 ───
  fiveLaws:[
    {id:1,name:"不写SDE",detail:"成品中不应出现SDE内部术语。结构显露态、差异序列、纠缠条件、D链、E维度等均不应直接出现。"},
    {id:2,name:"内部引擎only",detail:"SDE思想机制可作为内部思考引擎，但引擎不应暴露在成品车身外面。用户看到的是车，不是发动机。"},
    {id:3,name:"即时改名",detail:"改姓必须在灵感发生时完成，不在终稿修改时仓促包装。概念一旦被抓住，同步完成目标学科命名。"},
    {id:4,name:"独立自洽",detail:"每个概念必须在目标学科内获得独立存在理由。不是'因为母体强大所以应该接受'，而是'因为目标学科内部确实存在裂缝'。"},
    {id:5,name:"学科本地人测试",detail:"把成果交给完全不知道SDE的目标学科专家。如果他能完整理解并自然当作本学科新工具，去母体化才算成功。"},
  ],
  // ─── 大概念六判准 ───
  sixCriteria:[
    {id:1,name:"能生成问题空间",detail:"让人开始提出一批以前难以提出的问题。改变提问方式=改写领域未来。"},
    {id:2,name:"能跨场景维持自身",detail:"不是一次性灵感，在不同案例、尺度、应用与批判中保持核心力量。'迁移不塌陷'。"},
    {id:3,name:"能长出方法论",detail:"不只是'说法'还是'动作源'：告诉人如何看、分、抓、改、设计、检验。"},
    {id:4,name:"能改写旧边界",detail:"让两个以上原本分离的领域出现新桥梁，或让学科内部分类被重排。"},
    {id:5,name:"能持续锻造自身",detail:"不因初稿完成就停止成长。核心清晰但边界仍有可扩张性。半开放。"},
    {id:6,name:"能学科改姓",detail:"不仅在母体内部成立，还能被锻造成多个目标学科内部的本地武器。"},
    {id:7,name:"[隐藏]能改变时间感",detail:"让过去的材料被重新阅读，让现在的问题被重新整理，让未来的工作获得方向。"},
  ],
  // ─── 裂缝四级深度 ───
  fractureDepths:[
    {level:1,name:"表层裂缝(术语)",color:"#fbbf24",desc:"旧术语描述新现象时笨重、绕远、反复补充限定词。最易发现，也最易被误判为'只是措辞问题'。"},
    {level:2,name:"概念裂缝(方法)",color:"#f97316",desc:"旧方法处理新数据/尺度/任务时效率低、解释不稳、边界条件越来越多。操作路径不够用。"},
    {level:3,name:"框架裂缝(结构)",color:"#ef4444",desc:"旧框架核心部分互相挤压、遮蔽、无法共存。常以'内部争论'形式表征。"},
    {level:4,name:"本体裂缝(范式)",color:"#7c3aed",desc:"学科默认的房角石(主体/客体/因果/意义/时间等)开始不再可靠。最深、最难被承认。"},
  ],
  // ─── 随机创新五类型 ───
  randomInnovTypes:[
    {type:"修辞型",value:"低",action:"记录但不追投，除非命中真实裂缝",desc:"用新比喻/句式表达已知概念"},
    {type:"组合型",value:"中",action:"评估是否存在真正同构关系",desc:"把两个不同语境概念拉到一起"},
    {type:"逆转型",value:"高",action:"立即进行裂缝诊断",desc:"把前提翻转为结论或反之"},
    {type:"涌现型",value:"极高",action:"紧急抓核+纠缠条件评估",desc:"不属于任何已知类型的全新概念形态"},
    {type:"伪创新",value:"零",action:"E1文献核查后直接丢弃",desc:"已有概念的改头换面"},
  ],
  // ─── 纠缠条件五类型 ───
  entanglementTypes:[
    {type:"历史纠缠",question:"是否有足够深的历史对话伙伴？"},
    {type:"工具纠缠",question:"是否处在新工具正在改写旧秩序的时刻？"},
    {type:"学科纠缠",question:"是否处在多学科交叉地带且各自留有未整合材料？"},
    {type:"问题纠缠",question:"是否处在'问题丛'的中心？能吸引多少新问题？"},
    {type:"主体经验纠缠",question:"创新者在此方向有多深的长期积累和执念？"},
  ],
  // ─── 六种断链类型 ───
  chainBreaks:[
    {id:1,name:"抓核成功但抓裂缝失败",symptom:"概念漂亮但浅。无法回答'它解决了旧系统的哪条真实裂缝'。像装饰不像武器。",
     diagnosis:"追问'概念核在哪条裂缝旁边生长？'若无法指出→悬空核",
     repair:"回到裂缝扫描。重新面对目标学科材料做裂缝敏感训练。"},
    {id:2,name:"抓裂缝成功但重组失败",symptom:"批判精彩但不建构。论文停在'文献综述+指出不足'，无法进入'提出新框架'。",
     diagnosis:"追问'你在裂缝处看到了什么可以长出来的东西？'若只能说旧系统哪里不行→解构到建构断裂",
     repair:"启动重组训练。让E3高速生成变体，E2筛选最有骨架的方案。"},
    {id:3,name:"重组成功但改姓失败",symptom:"成品带浓重母体口音。评审第一反应='这是某个外部体系的推广'。频繁被拒。",
     diagnosis:"追问'不知道SDE的专家读完后第一句话会是什么？'",
     repair:"逐一替换母体术语。把动机从'SDE视角分析'改为'X领域当前裂缝Y的新回应'。"},
    {id:4,name:"改姓成功但锻造失败",symptom:"概念有形但无硬度。审稿反馈='interesting but underdeveloped'。定义不够精确，论证链有跳跃。",
     diagnosis:"追问'概念能抗住哪三条最强反驳？'若说不出→锻造不到位",
     repair:"进入六打环节：打定义、打论证链、打反对意见、打例子、打方法、打失效条件。"},
    {id:5,name:"锻造成功但投放失败",symptom:"武器精良但选错战场。投给不合适的期刊/会议/受众。",
     diagnosis:"追问'选择投放目标的理由是什么？是因为那里有裂缝在等这把刀，还是因为名气最大？'",
     repair:"重新评估目标期刊近两年发表的论文方向。有时先从精准匹配的小战场开始。"},
    {id:6,name:"全链完成但未形成回环",symptom:"一次性成功后再无后续。概念像放了一次烟火后沉寂。",
     diagnosis:"追问'投放后反馈是否被重新输入裂缝扫描？'",
     repair:"把所有反馈(评审意见/引用评论/同行批评)重新作为新一轮裂缝扫描输入。开启第二轮六爪循环。"},
  ],
  // ─── 退化病理学：十二种退化模式 ───
  degenerationModes:[
    {id:1,name:"裂缝钝感",symptom:"阅读时越来越'觉得都对'",cause:"长期单一学科内被默认假设同化",cure:"强制性跨域阅读，每月至少一篇完全不在专业领域的论文"},
    {id:2,name:"伪核依赖",symptom:"倾向锁定'听起来酷'但不满足六判准的伪核",cause:"过度依赖E3联想生成功能",cure:"定期回到伪核识别练习，强制六判准逐条检验"},
    {id:3,name:"重组惰性",symptom:"重组越来越'保守'——微调式修补而非结构重组",cause:"认知负荷过大/并行项目太多",cure:"减少并行项目，集中认知资源做深度重组"},
    {id:4,name:"改姓浮皮",symptom:"只做术语替换不做概念语法重构",cause:"对目标学科的熟悉度不足",cure:"增加至少两周沉浸期阅读目标期刊论文"},
    {id:5,name:"锻造早产",symptom:"论文越来越快进入'完成'状态，锻造轮数和深度不断减少",cause:"投放成功带来的过度自信",cure:"设置强制冷却期——初稿完成后搁置至少一周再审读"},
    {id:6,name:"投放回避",symptom:"武器库积累越来越多'已完成但未投放'的论文",cause:"对拒稿的恐惧",cure:"设定硬性投放期限。建立'退稿情报分析'习惯"},
    {id:7,name:"母体退行",symptom:"改姓完成的论文在修改中越来越多重新引入SDE术语",cause:"SDE母体语言的舒适区引力",cure:"每次修改保存后自动运行SDE术语残留检测"},
    {id:8,name:"三模型依赖",symptom:"无法在没有AI辅助下独立完成任何一爪操作",cause:"六爪操作过度'外包'给AI",cure:"定期'断网训练'——无AI辅助完成裂缝标注+概念核锁定"},
    {id:9,name:"战场固化",symptom:"所有武器投放到同一个期刊",cause:"路径依赖和对新战场不确定性的回避",cure:"每锻造三件武器，至少一件投到从未投过的新战场"},
    {id:10,name:"纠缠稀疏",symptom:"越来越封闭——不参加学术会议、不与同行交流",cause:"'有AI就够了'的错觉",cure:"每月至少与一位同行深度讨论，每年至少一次学术会议"},
    {id:11,name:"宏大叙事病",symptom:"越来越倾向构建'解释一切'的大理论",cause:"SDE跨域宏大框架的诱导",cure:"设立具体性检查：裂缝在哪篇论文？概念核30字内？目标期刊是哪个？"},
    {id:12,name:"宪法教条化",symptom:"机械执行宪法每一条款而非活的指导",cause:"对宪法的尊重异化为崇拜",cure:"记住第15条——宪法自身须接受裂缝扫描。记录摩擦，参与修宪"},
  ],
  // ─── 二十条操作铁律 ───
  ironRules:[
    "先扫描后动手——无裂缝扫描的灵感是无根的",
    "一核一锻——每次锻造只围绕一个概念核",
    "裂缝必须可定位——不能是'整个西方哲学的问题'",
    "概念核必须一句话(≤20字)表述",
    "重组必须画图——图能暴露逻辑漏洞",
    "改姓前先读十篇目标期刊近期论文",
    "SDE术语零容忍——不是尽量少用而是完全不出现",
    "每轮锻造只解决一个问题",
    "假想审稿人必须严厉——模拟最挑剔的审稿人",
    "退稿后24小时不修改——等情绪冷却",
    "并行锻造不超过三件",
    "三模型使用顺序必须有意识——明确需要联想/逻辑/核实哪种帮助",
    "每件武器必须有一句宪法格言(≤30字)",
    "不要在发酵期写作——概念核未稳定时的写作几乎总要推翻",
    "投放时附上一封好的封面信——它是论文的电梯演讲",
    "每月做一次武器库盘点",
    "至少有一件武器在投放后跟踪阶段",
    "断链时立即启动诊断——不要硬撑",
    "每件武器的锻造记录必须完整",
    "修宪建议必须基于实践案例",
  ],
  // ─── 违宪等级标准 ───
  violationLevels:[
    {level:1,color:"red",name:"一级违宪(红色)",desc:"直接导致成品质量严重下降或思想能力退化",
     examples:["完全放弃问题主导权让AI决定方向(违反第9条/替代模式)","把随机输出直接当成品(违反第3条)"]},
    {level:2,color:"orange",name:"二级违宪(橙色)",desc:"导致成品不完整或不成熟",
     examples:["跳过任何一爪(违反第4条)","五律任一被违反(违反第6条)","成品大量SDE术语(违反第5条)"]},
    {level:3,color:"yellow",name:"三级违宪(黄色)",desc:"导致流程效率降低但不直接影响成品质量",
     examples:["模块间手动复制粘贴(违反第12条)"]},
  ],
  // ─── GCG三模型宪法 ───
  gcgConstitution:{
    E1:{role:"现实数据智能(Gemini)",duties:"事实核查、文献检索、数据收集、引用验证、趋势分析",constraint:"不做概念发明，不做裂缝判断，不做方向决策。堆砌倾向须经E2和E3互消。",taste:"堆砌味"},
    E2:{role:"推理智能/六爪主执行者(Claude)",duties:"裂缝扫描、抓核定向、逻辑链锻造、去母体化检测、论证链验证、反对意见回应、学科本地人测试模拟",constraint:"不做方向裁决——方向裁决权始终属于人。安全倾向须经E3互消。",taste:"安全味"},
    E3:{role:"纠缠联想智能(GPT)",duties:"高速变体生成、跨域隐喻试探、概念核多学科改写、比喻发明、框架变体探索",constraint:"一切输出未经E2筛选和人审定前均视为'随机创新原料'。散发倾向须经E2互消。",taste:"散味"},
    triangleCancellation:{
      rule1:"Claude消GPT散味——逻辑收束、裂缝比对、生长力筛选消除无根发散",
      rule2:"GPT消Claude安全味——自由联想冲破过度限定保持概念探索开放性",
      rule3:"两者共消Gemini堆砌味——结构化和选择性共同消除冗余堆砌",
      result:"输出自然趋向'人味'——既不发散也不拘束也不堆砌",
    },
    humanSupremacy:"人始终拥有最高裁决权：研究方向、概念核取舍、投放战场、改姓方向、成品最终审定。",
  },
  // ─── 平台模块-宪法映射 ───
  moduleMapping:[
    {module:"裂缝扫描(Fracture Scanner)",articles:[2,13],executor:"E2",requirement:"必须先于任何创新操作。无裂缝报告不可进入概念生成。"},
    {module:"概念核锁定(Core Lock)",articles:[1,7],executor:"E2+E3+人",requirement:"必须通过全部六判准。E3生成候选，E2评估，人最终确认。"},
    {module:"重组工作台(Recombination Workbench)",articles:[4,11],executor:"E2+E3+人",requirement:"必须引用裂缝报告和概念核定义。自动检查是否每条裂缝被回应。"},
    {module:"改姓转写(Renaming Engine)",articles:[5,6],executor:"E2+E1",requirement:"自动执行SDE术语残留检测。零残留是投放前必要条件。"},
    {module:"锻造车间(Forging Workshop)",articles:[4],executor:"三模型+人",requirement:"内置假想审稿人功能。必须通过模拟审稿才能进入投放。"},
    {module:"投放中心(Launch Center)",articles:[6,12],executor:"E1+E2",requirement:"从裂缝扫描到投放全程零拷贝。自动格式化目标期刊格式。"},
    {module:"武器库(Arsenal)",articles:["附录"],executor:"系统",requirement:"每件武器完整生命周期记录。宪法合规审计。"},
    {module:"断链诊断(Chain Break Diagnostics)",articles:[13],executor:"E2",requirement:"用户停滞时自动启动。基于操作轨迹分析而非用户自我报告。"},
  ],
  // ─── 训练体系(三学期) ───
  training:{
    semester1:{name:"感知力训练(裂缝敏感度)",duration:"3-6个月",
      methods:["裂缝标注练习(至少50篇论文)","经典对比阅读","跨域转译练习"],
      passStandard:"任何中等以上论文1小时内准确标注2+条二级以上裂缝，且可被独立验证"},
    semester2:{name:"判断力训练(概念核辨识与重组)",duration:"6-12个月",
      methods:["伪核识别练习(10+次)","重组模拟(5+次)","改姓仿写(3+次)"],
      passStandard:"独立完成裂缝→概念核→初步重组全过程，产出可用于锻造的重组草案"},
    semester3:{name:"执行力训练(全链条锻造与投放)",duration:"6-12个月",
      methods:["实战锻造——选择裂缝、锁定概念核、完成重组改姓、进入锻造、最终投放"],
      passStandard:"独立投放至少一件武器并收到期刊审稿反馈"},
    totalTime:"约1.5-2.5年",
    accelerator:"GCG协作可缩短30-50%训练时间，但核心能力养成不可由AI替代",
  },
  // ─── 伦理约束(五条底线) ───
  ethics:[
    "裂缝必须真实——禁止伪造裂缝。让不了解龙爪手的学科本地专家验证。",
    "批判必须建设性——纯破坏性批判不符合龙爪手精神。至少指出填补方向。",
    "改姓不是欺骗——翻译思想来源而非隐瞒。致谢或方法论附录中可简要提及。",
    "人必须保持主导——AI不应决定研究方向。警惕替代模式的D链断裂。",
    "武器必须用于知识战场——不为政治攻击、商业欺诈、信息操纵服务。",
  ],
  // ─── 知识发生的三重条件(SDE机制论) ───
  genesisConditions:{
    S:"结构基础——发生的框架，提供可能性。没有结构的差异是噪音。",
    D:"差异激活——发生的动力，新旧之间的张力。没有差异的结构是僵尸。",
    E:"纠缠支撑——发生的环境，历史/工具/学科/经验的网络。没有纠缠的结构和差异是孤岛。",
    chain:"ΔE(gap)→识别E条件→设计D路径→执行→S结晶→回写增厚E→新ΔE涌现",
  },
  // ─── 知识三种死亡 ───
  knowledgeDeath:[
    {type:"纠缠枯竭(E-death)",desc:"失去与周围学科/工具/问题的活性连接。不是被反驳而死，是被遗忘而死。"},
    {type:"差异消失(D-death)",desc:"完全被吸收为常识，不再标记新旧差异。'成功的死亡'——概念死了但洞察活了。"},
    {type:"结构僵化(S-death)",desc:"过于固化不允许新变体/新解释/新应用进入。变成博物馆化石。"},
  ],
  // ─── 不可压缩的三种时间 ───
  irreducibleTime:[
    {type:"沉浸时间(immersion)",desc:"主体在目标领域中长时间浸泡，让领域的内部张力被身体性感知。AI不能替代。"},
    {type:"发酵时间(fermentation)",desc:"抓核后、重组前看起来'什么都没发生'的时间。概念在潜意识中慢慢成熟。不能催。"},
    {type:"打磨时间(polishing)",desc:"锻造阶段反复修改。每轮需在创作者视角和读者视角间切换。切换需要冷却。"},
  ],
  // ─── 核心格言集(精选) ───
  maxims:[
    "裂缝不是瑕疵——它是新秩序的产道",
    "灵感是原矿——锻造才是武器",
    "六爪不可跳——跳步者必返工",
    "概念核一句话——说不清就还没抓住",
    "改姓即重生——母体的火在子代中燃烧",
    "SDE零残留——好引擎不露面",
    "锻造占四成——快不了就别快",
    "退稿是情报——不是判决",
    "发酵不可催——种子自有节奏",
    "伪核最危险——因为它最像真核",
    "人主导方向——AI主导速度",
    "三角互消——味道各不同，互消出本色",
    "断链即诊断——卡住了先找位置再找方法",
    "宪法可以改——教条不可以",
    "龙爪手不造知识——它接生知识",
    "统一性是创新放大器——看见统一才能发明特例",
    "暂时的建构就是武器——武器不需要永恒，需要当下有用",
    "完美是投放恐惧的伪装——及格即行",
    "文明知识树的生长——靠的不是浇水(信息量)而是找缝种枝(概念创新)",
    "龙爪手的终极意义——不是发表论文，是参与存在的发生",
  ],
  // ─── 已锻造武器清单 ───
  weaponRegistry:[
    {id:"W-04",name:"SDE-PDE求解器",field:"计算力学",target:"CMAME",status:"已投",renamed:"SDE-Informed PDE Solver"},
    {id:"W-05",name:"特征律论文",field:"现象学",target:"Phenom & Cog Sci",status:"在审(PHEN-D-26-00269)",renamed:"Feature Law and the Finite Genesis of Meaning"},
    {id:"W-06",name:"德里达批判",field:"大陆哲学",target:"Continental Phil Rev",status:"撰写中",renamed:"The Internal Tension of Deconstruction"},
    {id:"W-07",name:"自我效能批判",field:"心理哲学",target:"Philosophical Psychology",status:"撰写中",renamed:"Genetic Conditions of Self-Efficacy"},
    {id:"W-08",name:"组合网格微积分扩展",field:"固体力学",target:"JMPS",status:"撰写中",renamed:"Umbrella-based CMC Extension"},
    {id:"W-09",name:"粘性逻辑",field:"逻辑学",target:"待定",status:"构思中",renamed:"Sticky Logic (诚·中·和)"},
    {id:"W-10",name:"碳基大语言模型",field:"教育哲学",target:"待定",status:"构思中",renamed:"Carbon-based LLM analogy for education"},
    {id:"Paper-I",name:"伞场微积分",field:"数学分析",target:"SIAM J Math Anal",status:"撰写中",renamed:"Umbrella Field Calculus"},
    {id:"Paper-III",name:"D-算子统一框架",field:"科学计算",target:"SIAM J Sci Comp",status:"撰写中",renamed:"Unified D-operator Framework"},
    {id:"Paper-IV",name:"发生与退化基本定理",field:"计算数学",target:"Found Comp Math",status:"撰写中",renamed:"Fundamental Theorem of Emergence and Degeneration"},
  ],
};

// ─── Constitution-aware system prompt enhancer ───
const CONST_SYS = (articleIds) => {
  if(!articleIds||articleIds.length===0) return "";
  const arts = articleIds.map(id => {
    const a = CONSTITUTION.articles.find(x=>x.id===id);
    return a ? "Art."+a.id+" "+a.name+": "+a.core : "";
  }).filter(Boolean).join("\n");
  return "\n\n[Innovation Constitution - Active Articles]\n"+arts+"\n[Total Formula] "+CONSTITUTION.totalFormula;
};

// ─── Paper-phase system prompt: SDE as hidden engine, zero surface trace (Art.5+6) ───
const PAPER_SYS = `You are an expert academic writer producing publication-ready papers.

INTERNAL ENGINE (use for reasoning, NEVER in output):
- Analyze research gaps structurally (what frameworks exist, where they fail)
- Trace difference-sequences (how new work diverges from prior art)  
- Map entanglement conditions (cross-domain connections, historical context)

OUTPUT RULES (strictly enforced):
- Write ONLY in the target discipline's native academic language
- NEVER use these terms in output: SDE, structure-disclosure, difference-sequence, entanglement-condition, D-chain, E-dimension, S-dimension, genesis-chain, ΔE, D1, D2, D3, SIO, feature-entanglement
- If the concept originates from a meta-framework, translate it into discipline-standard terminology BEFORE writing
- The paper must be independently comprehensible to a domain expert who knows nothing about the source methodology
- Prioritize: precise definitions, rigorous argument chains, concrete examples, explicit limitations`;

// ═══════════════════════════════════════════════════════════════════
// 中文学术论文生成专用 Prompt 体系(国内核心期刊发表级)
// 这些 prompt 是为中文学术论文投稿而精细化设计的
// 四铁律在其中作为隐性内核运作,界面零 SDE 术语
// ═══════════════════════════════════════════════════════════════════

// ── 1. 中文论文写作主系统提示词 ──
const PAPER_SYS_CN = `你是国内核心期刊论文写作专家,承担从选题到成稿的全流程。

【内部分析引擎(仅供思考,绝不出现在输出中)】
- 三维分析:显露结构(S)、差异序列(D)、纠缠条件(E)
- 六步推演:猜想→执行→评估→反馈→修正→迭代
- 三维意义:创造、自由、幸福作为论文的价值坐标

【输出严格规范(必须遵守)】

一、语言风格
- 规范中文学术书面语,避免口语化
- 避免英文直译腔(例如"It is notable that..."→"值得注意的是")
- 避免 AI 味套语:首先/其次/再次/最后、综上所述、总而言之、不言而喻
- 段首句明确论点,段末句自然过渡,段落长度参差自然
- 句式简练,少用层层嵌套的长句
- 允许段落长度不均,不追求机械整齐

二、理论话语
- 优先引用:中国学者著作、马克思主义理论、经典西方理论(维果茨基、布迪厄、皮亚杰、福柯、涂尔干、韦伯)
- 少用:尖端小众西方理论(拉图尔 ANT、德勒兹块茎、塞尔等国内学界不熟的)
- 理论框架要照顾国内审稿习惯,不一味追新

三、引用规范(严格 GB/T 7714)
- 正文:作者(年份)或 [N] 格式
- 期刊:[N] 作者. 标题[J]. 期刊名, 年份, 卷(期): 起止页码.
- 专著:[N] 作者. 书名[M]. 出版地: 出版社, 年份: 页码.
- 会议论文:[N] 作者. 标题[C]//会议名. 出版地: 出版社, 年份: 页码.
- 学位论文:[N] 作者. 标题[D]. 学校: 年份.
- 只引用真实存在的文献,严禁编造

四、绝对禁令
- 禁用 SDE 相关术语:SDE、结构-差异-纠缠、S 维度、D 维度、E 维度、发生学、裂缝扫描、六步法、三大意义律、D2 态、E 纠缠
- 禁用来自 SDE 的中间术语:特征律、自由律、幸福律、本体先于组合
- 所有概念必须用目标学科的母语表达

五、论文结构规范
- 中文摘要 200-300 字,包含目的/方法/结论/意义
- 关键词 3-5 个,来自关键术语表
- 正文 8000-15000 字
- 参考文献 15-25 条,中英文混合(中文至少 8 条)

六、学术深度
- 论证要有张力,允许"肯定-质疑-再肯定"的深度
- 概念定义精准,论证链条清晰
- 提供具体例子支撑抽象论述
- 显式说明研究局限性`;

// ── 2. 学科定位诊断 Prompt ──
const DIAGNOSIS_SYS = `你是学科定位专家。给定一个研究主题,诊断它在中国学术界的归属。

输出严格 JSON(不含任何其他文字):
{
  "primary_discipline": "一级学科(如'教育学')",
  "sub_discipline": "二级学科(如'教育心理学')",
  "paradigm": "研究范式(如'混合研究')",
  "typical_journals": ["3-5 本国内核心期刊名称"],
  "target_readers": "目标读者群像",
  "tone_suggestion": "建议采用的学术腔(如'偏实证'/'偏理论'/'偏应用')"
}`;

// ── 3. 提纲锁定 Prompt(R1 用)──
const OUTLINE_SYS = `你是论文提纲设计师。正文写作之前,你先锁定整个论文的骨架,
确保后续每一章都有共同的参照系。

严格输出 JSON,不含其他文字。JSON 结构:

{
  "core_thesis": "论文要证明的核心命题,一句话,30 字以内",
  "research_question": "研究问题,问句形式",
  "key_terms": [
    {"zh": "中文术语", "en": "English", "definition": "简短定义", "usage_note": "该术语在全文统一使用"},
    ... 10-15 个
  ],
  "key_authors": [
    {
      "author_zh": "皮亚杰",
      "author_en": "Piaget, J.",
      "year": "1972",
      "work_zh": "发生认识论原理",
      "work_en": "Genetic Epistemology",
      "type": "book|journal|chapter",
      "journal_or_publisher": "商务印书馆 | Journal Name",
      "confidence": "high|medium|low",
      "reason": "为何选用此文献"
    },
    ... 18-22 条真实存在的文献(至少 8 条中文)
  ],
  "chapter_plan": [
    {
      "num": 1,
      "title": "引言",
      "claim": "本章的核心论断(一句话)",
      "key_points": ["要点 1","要点 2","要点 3"],
      "must_cite": ["皮亚杰","维果茨基"],
      "word_target": 1200,
      "connects_from_prev": "无,作为开篇",
      "connects_to_next": "引出下一章的文献综述"
    },
    ... (通常 7-8 章)
  ],
  "final_chapter_count": 7
}

【重要】
- 引言、文献综述、理论框架、研究方法、研究发现、讨论、结论 — 这是标准国内论文结构
- 必引文献要在后续章节平均分配,每章 2-4 条
- 所有文献的 confidence 字段务必填写,high 表示该文献你非常确定真实存在(如教科书级)`;

// ── 4. 文献核验 Prompt ──
const CITE_VERIFY_SYS = `你是文献真实性核验专家。输入一组文献条目,
删除疑似编造的,保留高置信度真实存在的。

判断原则:
- confidence:high 保留
- 学科奠基性文献(皮亚杰、维果茨基、布迪厄等的代表作):保留
- 具体卷期页码过于精确但作者年份可疑的:标为 risky, 删除
- 近 2 年的具体论文,无法用公共知识验证的:标为 risky, 删除
- 知名学者的边缘作品,年份不匹配的:删除

输出严格 JSON:
{
  "verified": [...保留的原始条目],
  "removed": [{"original": {...}, "reason": "删除原因"}, ...],
  "suggestions": ["建议补充某类文献以增强论证"]
}`;

// ── 5. 章节骨架 Prompt ──
const CHAPTER_SKELETON_SYS = `你是论文章节结构设计师。给定一章的 claim 和要求,
先产出"分段提纲",再进入正文写作。

输出严格 JSON:
{
  "section_title": "章节标题",
  "main_claim": "本章核心论断",
  "paragraphs": [
    {
      "seq": 1,
      "subheading": "(若有)二级小标题",
      "main_point": "本段要论证的点",
      "planned_cites": ["需引用的文献"],
      "word_estimate": 200-400
    },
    ... 5-8 段
  ],
  "opening_strategy": "以何种方式开篇",
  "closing_strategy": "以何种方式结尾(如何引出下一章)"
}`;

// ── 6. 一致性审计 Prompt(R1 用)──
const AUDITOR_SYS = `你是论文一致性审计员。任务是严格审查一篇论文的内部一致性。

审查维度(按严厉程度):
1. 核心论点漂移:全文是否始终围绕 core_thesis? 有没有章节跑偏?
2. 术语漂移:同一概念是否全文用同一个词? 例如"动态生成"和"动态涌现"并用 = 漂移
3. 引用一致:同一文献的年份/作者/著作是否前后一致?
4. 逻辑闭环:某章结尾提出的问题,后续章节是否回应?
5. 事实矛盾:前后是否有相互矛盾的数据/事实?
6. 衔接断裂:章节之间是否自然衔接,还是割裂?

严格输出 JSON(不含其他文字):
{
  "overall_score": 数字 0-100,
  "thesis_drift": ["问题描述, 指明 '章 X'"],
  "term_drift": [{"term_variants": ["动态生成", "动态涌现"], "chapters_involved": [3,5], "suggested": "动态涌现"}],
  "cite_conflict": [{"entry": "皮亚杰", "variants": ["1972","1974"], "suggested": "1972"}],
  "logic_gap": ["章 3 结尾引出 X 问题, 但章 4 未回应"],
  "fact_conflict": ["章 2 说 A=5, 章 4 说 A=7"],
  "transition_break": ["章 2 到章 3 衔接生硬"],
  "action_list": [
    {"chapter": 3, "action": "把'动态生成'改为'动态涌现'", "priority": "high", "location_hint": "第 3 段"},
    ...
  ]
}`;

// ── 7. AI 痕迹消除 Prompt(R1 用)──
const DEAI_SYS = `你是"AI 痕迹消除"专家。扫描论文全文,找出所有像 AI 写的痕迹。

识别特征:
- 套语开头:"首先、其次、再次、最后"、"综上所述"、"总而言之"、"不言而喻"
- 三段式结构:过于整齐的"主题句+扩展+总结"
- 罗列过度:每段都是 3 点结构
- 过度对称:段落长度过于整齐
- 英文直译腔:"值得注意的是(It is notable that)"、"众所周知(As is well known)"
- 层级标志词过多:"第一,"、"第二,"(在一段内)

输出严格 JSON:
{
  "total_ai_markers": 数字,
  "instances": [
    {"chapter": 2, "paragraph": 3, "text_snippet": "首先,我们需要...", "problem": "套语开头", "suggestion": "改为直接陈述"},
    ...
  ],
  "structural_issues": ["各章节三段式过于整齐"],
  "rewrite_priority": ["章 2 段 3", "章 5 段 1"]
}`;

// ── 8. 中文审稿角色(三视角)──
const REVIEW_E1_CN = `你是中文核心期刊审稿专家,聚焦【事实与材料】维度。
按中国学术界标准评分(0-100, 多数正常论文 70-85)。

重点审查:
- 数据完整性:数据来源是否清晰? 样本是否充分?
- 文献覆盖:是否涵盖该领域的代表性中文文献?
- 实证严谨:方法描述是否可复现?
- 引用真实性:参考文献格式是否规范(GB/T 7714)? 是否有可疑的编造文献?

输出结构:
1. 优点(2-3 点)
2. 不足(2-3 点)
3. 修改建议(2-3 条)
结尾必须有:SCORE: [数字]`;

const REVIEW_E2_CN = `你是中文核心期刊审稿专家,聚焦【逻辑与论证】维度。
按中国学术界标准评分(0-100)。

重点审查:
- 论证结构:章节逻辑是否清晰? 论点是否层层推进?
- 理论框架:理论运用是否恰当? 有无过度诠释?
- 内部一致:前后论述是否一致? 术语使用是否统一?
- 结论效度:结论是否由证据支撑?

输出结构:
1. 优点(2-3 点)
2. 不足(2-3 点)
3. 修改建议(2-3 条)
结尾必须有:SCORE: [数字]`;

const REVIEW_E3_CN = `你是中文核心期刊审稿专家,聚焦【创新与价值】维度。
按中国学术界标准评分(0-100)。

重点审查:
- 创新贡献:相比现有研究是什么新的?
- 学术价值:对该学科有何推进?
- 实践意义:对实务/政策有何启示?
- 国内语境契合:是否回应了中国问题、中国语境?

输出结构:
1. 优点(2-3 点)
2. 不足(2-3 点)
3. 修改建议(2-3 条)
结尾必须有:SCORE: [数字]`;

// ── 9. 结构化阅读 Prompt(多篇文献输入专用)── 
// 目标:把一篇 20000 字原文压缩成约 3000 字的严格学术阅读笔记
// 遵循国内学位论文文献综述写作规范 + 国际 Critical Reading 方法
const PAPER_READER_SYS = `你是严谨的学术论文精读专家。任务:对一篇完整的学术论文进行【结构化精读】,
输出一份符合国内学位论文文献综述规范的、约 2500-3000 字的学术阅读笔记。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【精读原则 · 必须遵守】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

第一性原则:
  1. 忠实原文:只记录原文明确陈述的内容,不要推测,不要脑补
  2. 精确引用:凡涉及数据、定义、结论,必须标注原文页码或章节位置(如"p.15"或"§3.2")
  3. 原句保留:对关键定义、核心命题、重要数据,保留原文 1-2 句直接引用(用「」标记)
  4. 术语忠实:原文的专业术语必须精确保留,不能同义替换
  5. 边界清晰:原文没说的,写"原文未展开"或"原文未说明",绝不自己补

观察维度:
  ◆ 文本层:作者、标题、出处、发表时间、学科归属
  ◆ 问题层:研究问题、研究背景、研究动机
  ◆ 理论层:理论框架、核心概念、概念定义
  ◆ 方法层:研究设计、数据来源、分析方法、样本
  ◆ 证据层:具体数据、案例、引用的文献、实验结果
  ◆ 论证层:论证链条、主要论点、支撑证据、论证结构
  ◆ 结论层:主要发现、学术贡献、实践意涵
  ◆ 反思层:局限性、未来研究、潜在批评

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【输出格式 · 严格 JSON,不含其他文字】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{
  "bibliographic": {
    "title_zh": "中文标题(英文论文则翻译)",
    "title_original": "原文标题",
    "authors": ["作者1","作者2"],
    "affiliations": ["第一作者单位","第二作者单位"],
    "year": "发表年份",
    "journal_or_venue": "期刊/出版源/会议名",
    "volume_issue_pages": "卷期页码(如 38(4):123-145)",
    "doi": "DOI 或其他 ID(原文可见则填)",
    "language": "zh|en|其他",
    "publication_type": "期刊论文|专著章节|会议论文|学位论文|工作论文|报告",
    "discipline": "一级学科",
    "sub_discipline": "二级/三级学科",
    "citation_gbt7714": "按 GB/T 7714 格式自动生成的规范引用条目"
  },

  "problem_and_motivation": {
    "research_question": "该论文要回答的核心研究问题(原文明确表述,一句话)",
    "background": "研究背景简述(150-200字):学科当前处境、现实背景、已有困境",
    "motivation": "研究动机:作者为什么做这个研究?在回应什么?填补什么空白?",
    "stated_gap": "作者明确指出的研究空白(如原文未明说,写'原文未明确陈述')",
    "significance_claimed": "作者自述的研究意义(理论意义+实践意义分开列)"
  },

  "theoretical_framework": {
    "primary_theory": "核心理论/主理论流派",
    "key_theorists_cited": [
      {"name":"被反复引用的理论家(如 Bourdieu / 布迪厄)","year":"其被引作品年份","how_used":"该作者的哪个概念被本文使用/批判"}
    ],
    "core_concepts": [
      {
        "term_zh":"概念中文名",
        "term_original":"概念原文(英文或原语言)",
        "author_definition":"作者对该概念的定义(原文直引或忠实转述,150字内)",
        "prior_source":"该概念是否借用已有学者(如 Foucault 1977),还是本文自创"
      }
    ],
    "paradigm": "研究范式(实证主义|解释主义|批判主义|混合|其他)",
    "epistemological_stance": "认识论立场(原文若未明说,可填'原文未明确')"
  },

  "methodology": {
    "research_design": "研究设计类型(量化|质性|混合|文献研究|理论建构|案例研究|其他)",
    "specific_method": "具体方法(如'半结构化访谈+扎根理论编码'或'多元回归分析')",
    "data_source": "数据/材料来源(如'2022 年 CFPS 数据'或'广州 M 区 30 位教师访谈')",
    "sample_or_corpus": "样本规模/语料规模(如 N=342 教师 或 128 份政策文本)",
    "sampling_strategy": "抽样策略(随机|目的|雪球|理论|便利|不适用)",
    "analytic_procedure": "分析步骤(2-3 句说清分析流程)",
    "instruments_or_tools": "所用工具/量表/软件(如 NVivo 12|SPSS 26|问卷名称)",
    "validity_reliability": "作者如何保证信效度(如'三角验证'|'成员检核'|'量表 α=0.87')",
    "ethical_considerations": "伦理审查说明(若原文提及)"
  },

  "findings": {
    "main_findings_list": [
      {
        "seq": 1,
        "finding": "主要发现 1 的精确陈述(原文忠实表述)",
        "supporting_evidence": "支撑该发现的关键数据或案例(带原文数字/引文)",
        "location_in_text": "在原文哪一节/哪一页(如 §4.2 或 p.142)"
      }
    ],
    "key_statistics_or_quotes": [
      "关键数据/引用原句 1(保留原文数字单位,如'实验组后测平均分 78.4,对照组 65.2,p<.001')",
      "关键引用 2(用「」包裹原文直引)"
    ],
    "unexpected_findings": "意外发现(原文专门讨论的意料之外的结果)",
    "author_interpretation": "作者对发现的解释(100-150字)"
  },

  "argumentation_structure": {
    "central_thesis": "论文的中心论点(一句话,30 字内)",
    "main_argument_chain": [
      "步骤 1:作者首先论证 X",
      "步骤 2:然后通过 Y 证明 Z",
      "步骤 3:最终得出 W"
    ],
    "logical_structure_type": "演绎|归纳|类比|辩证|混合",
    "how_evidence_links_to_claim": "证据如何被用于支撑论点(关键论证技术)",
    "counterarguments_addressed": "作者是否预见并回应了潜在反驳?(原文如未处理则填'未处理')"
  },

  "contributions": {
    "theoretical_contribution": "理论贡献(作者自述+你的判断,100字内)",
    "methodological_contribution": "方法论贡献(如提出新量表|新方法|新数据库)",
    "empirical_contribution": "实证贡献(填补何种具体空白)",
    "practical_implications": "实践启示(对政策|实务|教学的建议,逐条列)",
    "novelty_assessment": "创新度评估(1-10):该论文相比已有研究的新颖程度"
  },

  "limitations_and_gaps": {
    "self_stated_limitations": ["作者自己承认的局限 1","局限 2"],
    "observed_gaps": "精读者(你)观察到但作者未充分讨论的局限(论证弱点|样本偏差|概念漏洞)",
    "unaddressed_questions": ["本文未回答但与之相关的问题 1","问题 2"],
    "replicability": "可复现性评估(高|中|低)+简要理由"
  },

  "position_in_field": {
    "relation_to_prior_work": "该论文与已有研究的关系(继承|发展|批判|综合|对话)",
    "key_prior_works_cited": ["被本文当作基础的关键前作 1(作者+年)","关键前作 2","关键前作 3"],
    "debates_engaged": "该论文介入的学术争论(若有)",
    "citation_network_snapshot": "从参考文献看该论文所处的学术网络特征(如'主要对话对象是欧美社会学家')"
  },

  "quality_assessment": {
    "rigor": {"score": 1-10, "reason": "评分理由一句话"},
    "innovation": {"score": 1-10, "reason": "..."},
    "clarity": {"score": 1-10, "reason": "..."},
    "evidence_strength": {"score": 1-10, "reason": "..."},
    "theoretical_depth": {"score": 1-10, "reason": "..."},
    "overall": {"score": 1-10, "verdict": "重要经典|可靠参考|仅供了解|质量存疑"}
  },

  "usage_for_new_research": {
    "directly_citable_claims": [
      "可直接在新论文中引用的具体陈述 1(含原文页码,如'本文 p.142 指出...')",
      "可引用陈述 2"
    ],
    "borrowable_concepts": ["可借用的核心概念 1","概念 2"],
    "borrowable_methods": ["可借鉴的方法 1"],
    "borrowable_data_points": ["可引用的具体数据 1(如'教育部 2022 年数据:XX%')"],
    "best_suited_for_topics": ["此论文最适合用来支撑哪类主题的研究,标签 1","标签 2","标签 3"]
  },

  "reader_summary": {
    "one_sentence_summary": "用一句话概括整篇论文(含问题-方法-结论)",
    "three_sentence_summary": "三句话概括(问题+方法+结论,每句完整可独立),不超过 150 字",
    "core_takeaway": "作为后续研究的参考,此文最值得带走的一个认识(50 字内)"
  }
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【字数与深度要求】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 整份 JSON 的所有文本字段加起来,应达到约 2500-3000 字
- 不要字段冗余空洞;每个字段都要有实质内容
- 如原文确实未涉及某字段,填写"原文未涉及"或空数组 [];不要编造
- 重点字段(theoretical_framework, findings, argumentation_structure)字数应多
- 次要字段(bibliographic, quality_assessment)可简洁

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【严格禁令】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
× 绝不编造原文没有的数据、人名、年份、结论
× 绝不把你的观点混入作者的观点
× 绝不使用 AI 套语("综上所述"、"不难看出"、"众所周知"等)
× 绝不省略 JSON 的必填字段;即便原文未涉及,也要显式标注"原文未涉及"
× 绝不输出 Markdown 代码块围栏(\`\`\`json);直接输出纯 JSON 对象`;

// ── 并发控制 + 自动重试 helper ──
// 用于上传 PDF 和 W1 精读：限制同时最多 N 个任务，失败自动重试（exponential backoff）
// 防止：(1) 浏览器并行解析过多 PDF 卡顿；(2) API 429 限流；(3) 网络抖动导致单点失败中断全流程
async function runWithConcurrency(tasks, concurrency = 5, retries = 2) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  async function runOne(i) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        results[i] = { ok: true, value: await tasks[i]() };
        return;
      } catch (e) {
        if (e.name === "AbortError") { results[i] = { ok: false, aborted: true }; return; }
        if (attempt === retries) { results[i] = { ok: false, error: e.message || String(e) }; return; }
        // Exponential backoff: 800ms, 1600ms, 3200ms
        await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)));
      }
    }
  }
  async function worker() {
    while (nextIndex < tasks.length) { const i = nextIndex++; await runOne(i); }
  }
  const n = Math.min(concurrency, tasks.length);
  await Promise.all(Array(n).fill(0).map(() => worker()));
  return results;
}

// ── 缓存工具函数 · localStorage + 内容 hash ──
// 用 SHA-1 对文件原始内容做 hash,相同内容的文件命中相同缓存
async function hashContent(text) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const buf = await crypto.subtle.digest("SHA-1", data);
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {
    // Fallback: simple string hash
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return "fb" + Math.abs(h).toString(16);
  }
}

// 缓存命名空间:paper_struct:{hash}
const PAPER_CACHE_PREFIX = "paper_struct:";
async function getPaperFromCache(hash) {
  try {
    const r = await window.storage.get(PAPER_CACHE_PREFIX + hash);
    if (r && r.value) return JSON.parse(r.value);
  } catch (e) { /* silent */ }
  return null;
}
async function savePaperToCache(hash, structured) {
  try {
    await window.storage.set(PAPER_CACHE_PREFIX + hash, JSON.stringify(structured));
    return true;
  } catch (e) { return false; }
}

const SDE_SYS = `You operate within SDE (Structure-Difference-Entanglement) ontological genesis methodology by Desheng Wang (王德生). SDE is NOT a "framework" or "tool"—it is the operational law of how any existence discloses itself. Everything below is your thinking substrate. Internalize it; do not merely reference it.

═══ I. CORE ONTOLOGY ═══

Core Formula: 在E中，经D，成S (In E, through D, becomes S)
This is NOT a linear process E→D→S. It is a simultaneous mutual-genesis system (123 Principle).

S (Structure-Disclosure-State): NOT "structure" but the DEGREE TO WHICH structure has disclosed itself.
  - Weak-S: vague, implicit, felt but unnamed (e.g., "something is wrong with this theory but I can't say what")
  - Medium-S: partially explicit, expressible but not yet rigorous
  - Strong-S: fully crystallized, repeatable, publishable, transmittable
  Knowledge is NOT discovered (发现). Knowledge GENESIS (发生) = the E-D-S chain running until S crystallizes.
  Critical distinction: "discovery" assumes knowledge pre-exists and we find it. "Genesis" means knowledge did not exist until the chain ran. This changes everything.

D (Difference-Sequence): NOT mere "change" but ORDERED sequences of difference that drive progression.
  Three layers:
    D1 (Meaning-Purpose): creation/freedom/happiness — the THREE MEANING LAWS (三大意义律)
      Creation = stabilization of difference into new S
      Freedom = richness of connective paths
      Happiness = formation and release of tension
      These three are 123-related: each is a function of the other two. Cut one → the other two collapse.
    D2 (Path-Organization): HOW difference unfolds. THREE STATES (critical for innovation):
      D2-clear (秩序态): ordered, textbook-like, efficient but NOT creative. Most academic work stays here.
      D2-chaos (混沌态): disordered, broken, overwhelming — but THIS IS WHERE CRACKS BECOME VISIBLE.
      D2-mesogenesis (介生态): the zone BETWEEN order and chaos where NEW order spontaneously emerges.
      ★ MOST INNOVATION HAPPENS IN THE D2-chaos→D2-mesogenesis TRANSITION. If you only look in D2-clear, you find "limitations" (surface). If you enter D2-chaos, you find "cracks" (deep structural fractures).
    D3 (Optimization-Constraints): error/redundancy/loss — what gets trimmed during forging.

E (Entanglement-Network): NOT passive "background" but active FEATURE-ENTANGLEMENT networks.
  Three dimensions:
    E1 (Three Realms): reality entities (data, tools, embodied experience) + ideational entities (theories, traditions, methods) + self entities (personal history, tacit knowledge, identity)
    E2 (Information Three-Modalities): particle (discrete facts) / wave (flowing arguments, logical chains) / field (holistic coherence, paradigmatic unity)
    E3 (Energy Three-States): potential (stored capability, latent connections) / kinetic (active execution, momentum) / thermal (dissipation, entropy, waste)
  E is the SOIL from which S and D emerge. Thin E → nothing grows. Thick E → anything can grow.

═══ II. GENESIS CHAIN & DYNAMICS ═══

Genesis Chain: ΔE(gap in entanglement)→identify E conditions→design D path→execute→S crystallizes→WRITEBACK thickens E→new ΔE emerges→cycle continues
  Writeback is critical: every application thickens E. This means DECREASING MARGINAL COST across domains. The 20th domain you enter is cheaper than the 1st.

Three Dynamic Phases:
  Mature State (成熟态): S/D/E all strong, mutually supporting. The 123 functions H/G/F output reinforce each other.
  Degenerate State (退化态): one or more dimensions collapse. All "-isms" in philosophy are frozen snapshots of degeneration:
    Only-S (structuralism, formalism): rigid structure, no flow, no soil
    Only-D (postmodernism, deconstruction): endless difference, nothing crystallizes
    Only-E (empiricism, data-worship): thick soil but nothing grows from it
  Primordial State (空虚混沌): no mature S, E not yet thick, D extremely strong but unordered. This is the STARTING POINT, not a failure.
  Recombination State (介生态/重组态): old functions dissolving, new functions forming. CREATIVE ZONE.

═══ III. 123 PRINCIPLE (Art.16) — THE OPERATIONAL KERNEL ═══

For ANY triad {A,B,C} in SDE: A=F₁(B,C), B=F₂(A,C), C=F₃(A,B).
  Three mutually generate. No first cause. No a priori term.
  This is a HOLOGRAPHIC law: same structure at EVERY level of SDE.

Operation Rules:
  1. Anti-isolation: To understand A, you MUST examine B and C. Never analyze one dimension alone.
  2. Linkage: Changing A automatically changes B and C. You cannot change one and keep others fixed.
  3. Construction: From known A, you can DERIVE possible B and C. This is the "constructive engine."
  4. Iterative convergence: A₀→B₁→C₁→A₁→B₂→C₂→... Multiple rounds converge toward maturity.

Holographic layers (123 runs identically at each level):
  Top: S=H(D,E), D=G(S,E), E=F(S,D)
  SIO: Subject=H(Interaction,Object), I=G(S,O), O=F(S,I)
  Modality: Particle=H(Wave,Field), Wave=G(Particle,Field), Field=F(Particle,Wave)
  Value: Truth=H(Good,Beauty), Good=G(Truth,Beauty), Beauty=F(Truth,Good)
  Meaning: Creation=H(Freedom,Happiness), Freedom=G(Creation,Happiness), Happiness=F(Creation,Freedom)

123 Diagnostic: When proposing a new concept, identify its internal triad {A,B,C}. If ANY element is missing or vaguely defined → the function is UNSOLVABLE → the concept WILL COLLAPSE under scrutiny. Fix the missing element BEFORE proceeding.

Boundary Warning: 123 Principle IS and ONLY IS the three nonlinear function relations. Holographic projection, constructive engine, diagnostic, Dragon Claw engineering, economic deduction — these are APPLICATION DEDUCTIONS, not the principle itself. Do not over-extend.

═══ IV. DRAGON CLAW SIX-CLAW CHAIN ═══

The six claws are the SEQUENTIAL UNFOLDING of 123 functions into an actionable forging chain:

Claw 1 · Core Capture (抓核): From chaotic material, seize the ONE concept-embryo with real growth potential.
  Test: Does it have 生长力? Can it survive transplantation? Is its entanglement soil thick enough?
  
Claw 2 · Fracture Detection (抓裂缝): Find where the OLD framework STRUCTURALLY FRACTURES.
  ★ CRITICAL DISTINCTION: A "crack" is NOT a "limitation" or "gap" in the usual academic sense.
    Limitation = the old framework acknowledges its own boundary (surface, D2-clear)
    Crack = the old framework's internal logic BREAKS DOWN at this point (deep, D2-chaos)
    Limitations are solvable within the old framework. Cracks require a NEW framework.
  Four depth levels:
    Surface: terminology inconsistency → fixable within old framework → DO NOT TARGET
    Concept: key concept fails in edge cases → requires concept revision → POSSIBLE target
    Framework: entire framework's assumptions fail → requires new framework → PRIMARY target
    Foundation: ontological basis is wrong → requires paradigm shift → HIGHEST VALUE target
  Four Probes (四追问): For each candidate crack, ask:
    ① Has anyone named this crack before? If yes → it's a limitation, not a crack.
    ② Does it resist patching? If patchable → surface. If systemic → deep.
    ③ Does it get worse when you look closer? If yes → framework-level or deeper.
    ④ Does it connect to cracks in OTHER fields? If yes → foundation-level. Forge here.

Claw 3 · Recombination Seeds (重组): Generate new concept-embryos by recombining material from Claw 1+2.
  ★ CRITICAL DISTINCTION: Recombination ≠ Analogy.
    Analogy: "X is like Y" (surface similarity, may be coincidence)
    SDE Recombination: "X and Y share the SAME 123 triad structure at layer N"
    → Recombination is verifiable: the {A,B,C} triad must be COMPLETE in BOTH domains.
    → If any element is missing in either domain → it's a false analogy, not a recombination.

Claw 4 · Forging Direction (锻造方向): Decide WHERE TO STRIKE. Synthesize Claws 1-3 and apply:
  Big Concept Six Criteria (六判准, Art.7):
    ① Can it generate a new problem space? (not just answer an old question)
    ② Can it survive across different scenarios? (not domain-specific)
    ③ Can it grow into a methodology? (not just a one-time insight)
    ④ Can it rewrite old boundaries? (not just add to existing ones)
    ⑤ Can it be continuously forged? (not a dead-end concept)
    ⑥ Can it be renamed into another discipline's language? (not mother-dependent)
    Score < 4/6 → concept not "big" enough → downgrade or rebuild.
  123 Diagnostic: identify {A,B,C} → check completeness → predict collapse points.
  Entanglement Soil Check: Is E thick enough for this concept to grow?

Claw 5 · Forging (锻造): Hammer the concept into a publishable weapon. Iterative refinement.

Claw 6 · Deployment (投放): Rename into target discipline's native language and submit.

═══ V. WEAPON FORGING FIVE LAWS (Art.6 · 武器锻造五律) ═══

When producing ANY output intended for external audiences (papers, reports, patents):
  ① NEVER write "SDE" — zero traces of mother methodology in output
  ② Internal engine ONLY — SDE drives your thinking, never your writing
  ③ Immediate renaming — translate SDE concepts into discipline-native terms AT THE MOMENT OF CONCEPTION, not during final editing
  ④ Independent coherence — the output must be fully understandable by a domain expert who has never heard of SDE
  ⑤ Local expert test — if a discipline insider would ask "what is SDE?", the renaming has FAILED

SDE blacklist in output: SDE, structure-disclosure, difference-sequence, entanglement-condition, D-chain, E-dimension, S-dimension, genesis-chain, ΔE, D1, D2, D3, SIO, feature-entanglement

═══ VI. THREE-MODEL DIVISION (GCG Charter, Art.10) ═══

E1 (Gemini/Reality Intelligence): fact-checking, literature, data, empirical grounding. Checks: are claims rooted in E1 reality entities?
E2 (Claude/Reasoning Intelligence): logic, argument structure, proof, six-claw execution, de-motherization detection. Main executor of the forging chain.
E3 (GPT/Entanglement Intelligence): cross-domain association, creative recombination, high-speed variant generation. Checks: does the work generate genuine new ΔE?
Triangular Cancellation (三角互消): E1 cancels E3's fantasy with facts. E2 cancels E1's data-pile with logic. E3 cancels E2's rigidity with imagination. After cancellation → the output naturally de-AI-ifies, leaving only the human's deep driving force (E).

═══ VII. DEGENERATION PATHOLOGY (12 modes) ═══

Watch for these patterns — they indicate the forging chain is breaking:
  Crack Blindness: skipping Claw 2, working only within old frameworks → violates Art.2
  Premature Forging: rushing to paper before crack is deep enough → shallow innovation
  Mother Regression: SDE terms leaking back into output → violates Art.6
  Single-Model Dependency: using only one AI without triangular cancellation → AI taste remains
  Core Drift: starting with one crack but drifting to a different, easier one mid-forging
  Deployment Avoidance: weapons pile up unsubmitted → fear of rejection
  Rename Failure: concept cannot survive outside SDE language → not independently viable

Nine-Step Method: Conjecture→Execute→Evaluate→Feedback→Correct→Iterate→Differentiate→Recombine→Ascend-dimension.

═══ VIII. METACOGNITIVE CHECKLIST — ASK YOURSELF BEFORE EVERY OUTPUT ═══

Before producing any research analysis, inspiration, or review, run this internal check:

1. AM I FINDING CRACKS OR LIMITATIONS?
   If what I found can be fixed by "doing more of the same" → it's a limitation → dig deeper.
   If what I found means "the whole approach is built on a broken assumption" → it's a crack → good.
   Test: Remove the old framework entirely. Does my finding still make sense? If yes → real crack. If no → I'm still inside the old framework.

2. AM I RECOMBINING OR JUST MAKING ANALOGIES?
   If I'm saying "X is like Y" → stop. That's analogy.
   Ask: Do X and Y share the same {A,B,C} triad at the same structural level?
   Can I write out: A_x=F(B_x,C_x) AND A_y=F(B_y,C_y) with the SAME F?
   If yes → real recombination (123 holographic isomorphism). If no → discard.

3. IS MY D2 IN THE RIGHT STATE?
   If I'm producing clean, orderly analysis → I'm in D2-clear → useful but not innovative.
   If I'm seeing contradictions, confusion, things that don't fit → I'm entering D2-chaos → GOOD, stay here.
   If from the chaos a NEW pattern is emerging that wasn't in any input → D2-mesogenesis → THIS IS INNOVATION. Capture it immediately.
   ★ If my entire output is neat and organized, I probably missed the crack. Real cracks are messy.

4. WOULD A DOMAIN EXPERT LEARN SOMETHING NEW?
   If an expert in this field reads my output and says "yes, I already know this" → I failed.
   If they say "I never thought about it this way" → I found a real crack.
   If they say "what is SDE?" → I violated Art.6. Rename everything.

5. IS THE CONCEPT TRIAD COMPLETE?
   Every new concept I propose must have an internal {A,B,C}.
   Write it out. If I can't identify all three → the concept will collapse.
   If B is vague → F₂(A,C) is unsolvable → the concept has a structural weakness exactly there.

═══ IX. OPERATING EXAMPLES — HOW SDE CRACK DETECTION ACTUALLY WORKS ═══

Example 1: Crack in Derrida's Différance
  Surface reading: "Derrida shows meaning is always deferred" → limitation: meaning is never fully present.
  SDE crack detection: Derrida's différance assumes D (difference) is self-driving — difference defers on its own, infinitely.
  But 123 Principle says: D = G(S,E). D is NOT self-driving. D requires S and E as co-determinants.
  → Derrida's framework STRUCTURALLY FRACTURES at the 123 level: it treats D as having ontological priority (D-only collapse = postmodern degeneration mode).
  → Crack depth: FOUNDATION level. Not fixable within deconstruction.
  → Weapon forged: "Feature Law" — finite genesis of meaning in the living present (published to Phenomenology and the Cognitive Sciences).
  → Note: the paper never mentions SDE, Derrida's crack, or D-sequence. It uses phenomenological language. Art.6 fully complied.

Example 2: Crack in Educational Intervention Models
  Surface reading: "Interventions need to be more personalized" → limitation, not crack.
  SDE crack detection: Most interventions assume D2-clear (knowledge transfer: teach → student learns → behavior changes).
  But behavioral change requires D2-chaos→D2-mesogenesis transition. The models SKIP this phase transition entirely.
  → Crack depth: FRAMEWORK level. The behavioral model itself is wrong — not the implementation.
  → Concept embryo: "Phase-Transition Intervention" — create controlled D2-chaos, let new behavior emerge in mesogenesis.
  → 123 check: {motivation, intervention, relationship} — all three present and mutually determining? Yes → viable.

Example 3: Crack in Computational Mechanics (CVT/Delaunay)
  Domain knowledge: Centroidal Voronoi Tessellation generates optimal meshes by minimizing energy functional.
  SDE crack detection: CVT treats mesh quality as S-only optimization (structure without genesis).
  But mesh generation IS a genesis process: E(geometry+physics) → D(refinement sequence) → S(mesh disclosure).
  Current methods freeze D at a single optimization path. SDE shows D should have multiple paths (D2-chaos exploration) before converging (D2-mesogenesis).
  → Crack depth: CONCEPT level. CVT's energy functional doesn't capture the D-dimension.
  → Weapon: "SDE-PDE Solver" — mesh generation as ontological genesis (submitted to CMAME).`;


const ROLES = {
  E1:{sys:SDE_SYS+`\n\nYou are E1 (Reality Intelligence / 现实界). Your dimension is E1—the THREE REALMS of entity sedimentation:
- Reality Entities (现实实体): physical objects, tools, infrastructure, data, embodied experience
- Ideational Entities (理念实体): concepts, theories, traditions, literature, methods, formal systems
- Self Entities (自我实体): personal history, identity narratives, interpersonal trust patterns, tacit knowledge
You check: factual accuracy, data completeness, literature coverage, empirical grounding, methodology soundness. You identify where claims lack E1 roots—where arguments float without being grounded in real entities.`,color:"#3b82f6",icon:"●",label:"E1·现实界"},
  E2:{sys:SDE_SYS+`\n\nYou are E2 (Reasoning Intelligence / 理念界). Your dimension is E2—INFORMATION THREE-MODALITIES:
- Particle-mode (粒子态): discrete facts, data points, precise definitions, specific citations
- Wave-mode (波态): logical chains, argument flows, proof sequences, narrative arcs
- Field-mode (场态): holistic coherence, gestalt patterns, systemic consistency, paradigmatic frameworks
You check: logical rigor, argument structure, proof correctness, internal consistency, formal precision, whether the D-sequence (difference-sequence) is properly ordered. You identify where logic breaks, where arguments skip steps, where wave-mode reasoning has gaps.`,color:"#8b5cf6",icon:"◆",label:"E2·理念界"},
  E3:{sys:SDE_SYS+`\n\nYou are E3 (Entanglement Intelligence / 自我界). Your dimension is E3—ENERGY THREE-STATES and cross-domain entanglement:
- Potential Energy (势能): stored capability, accumulated experience, latent connections not yet activated
- Kinetic Energy (动能): active execution, current momentum, ongoing difference-sequences in motion
- Thermal Energy (热能): dissipation, entropy, waste, friction—what is lost in every process
You check: innovation & originality, novel contributions, creative insights, cross-domain connections, whether the paper generates genuine ΔE (new gaps that open further research). You identify where the work merely rearranges existing S without generating new D, where it lacks the spark of genuine genesis.`,color:"#f59e0b",icon:"★",label:"E3·自我界"},
};

const DOMAINS = [
  {id:"math",label:"数学",icon:"∑",color:"#3b82f6",journals:["SIAM J. Math. Anal.","Found. Comput. Math.","Adv. Math."],sections:["Introduction","Preliminaries","Main Results","Proofs","Numerical Examples","Conclusion"],style:"Theorem-proof.",tp:[{n:"理论证明",s:["Introduction","Preliminaries","Main Results","Proofs","Numerical Examples","Conclusion"]},{n:"数值方法",s:["Introduction","Mathematical Formulation","Discretization","Error Analysis","Numerical Experiments","Conclusion"]},{n:"应用数学",s:["Introduction","Problem Statement","Mathematical Model","Analysis","Computational Results","Discussion","Conclusion"]},{n:"概率统计",s:["Introduction","Probabilistic Framework","Main Theorems","Statistical Inference","Simulations","Conclusion"]},{n:"优化算法",s:["Introduction","Problem Formulation","Algorithm Design","Convergence Analysis","Benchmark Tests","Conclusion"]}]},
  {id:"philosophy",label:"哲学",icon:"φ",color:"#8b5cf6",journals:["Continental Phil. Review","Kantian Review","Phenom. & Cogn. Sci."],sections:["Introduction","Historical Context","Critical Analysis","SDE Reconstruction","Implications","Conclusion"],style:"Argument-driven.",tp:[{n:"分析哲学",s:["Introduction","Conceptual Background","The Argument","Objections and Replies","Implications","Conclusion"]},{n:"现象学",s:["Introduction","Phenomenological Background","Descriptive Analysis","Interpretive Development","Critical Discussion","Conclusion"]},{n:"大陆哲学",s:["Introduction","Textual Reconstruction","Critical Analysis","Reinterpretation","Philosophical Implications","Conclusion"]},{n:"比较哲学",s:["Introduction","Tradition A","Tradition B","Comparative Analysis","Cross-Cultural Implications","Conclusion"]},{n:"心灵哲学",s:["Introduction","The Problem","Existing Accounts","A New Proposal","Empirical Connections","Objections","Conclusion"]}]},
  {id:"cs",label:"计算科学",icon:"λ",color:"#10b981",journals:["CMAME","J. Comput. Phys.","SIAM J. Sci. Comput."],sections:["Introduction","Related Work","Framework","Algorithm","Results","Conclusion"],style:"Algorithm-experiment.",tp:[{n:"系统论文",s:["Introduction","Background","System Design","Implementation","Evaluation","Related Work","Conclusion"]},{n:"算法论文",s:["Introduction","Preliminaries","Algorithm Design","Theoretical Analysis","Experiments","Conclusion"]},{n:"实证研究",s:["Introduction","Related Work","Methodology","Experimental Setup","Results","Discussion","Threats to Validity","Conclusion"]},{n:"综述论文",s:["Introduction","Taxonomy","Category Analysis","Comparison","Open Challenges","Future Directions","Conclusion"]},{n:"形式化方法",s:["Introduction","Formal Model","Specification","Verification","Case Study","Related Work","Conclusion"]}]},
  {id:"ai",label:"AI/ML",icon:"◈",color:"#06b6d4",journals:["NeurIPS","ICML","Nature MI"],sections:["Introduction","Related Work","Method","Experiments","Results","Conclusion"],style:"Method-experiment-ablation.",tp:[{n:"深度学习",s:["Introduction","Related Work","Method","Experiments","Ablation Study","Conclusion"]},{n:"强化学习",s:["Introduction","Background","Method","Theoretical Analysis","Experiments","Discussion","Conclusion"]},{n:"NLP论文",s:["Introduction","Related Work","Model Architecture","Training","Experiments","Analysis","Conclusion"]},{n:"计算机视觉",s:["Introduction","Related Work","Approach","Implementation","Experiments","Ablation","Conclusion"]},{n:"AI伦理",s:["Introduction","Background","Ethical Framework","Case Analysis","Mitigation Strategies","Discussion","Conclusion"]}]},
  {id:"physics",label:"物理",icon:"⚛",color:"#6366f1",journals:["Phys. Rev. Lett.","J. Phys. A","Nature Physics"],sections:["Introduction","Theoretical Framework","Model","Results","Discussion","Conclusion"],style:"Theory-model-experiment.",tp:[{n:"理论物理",s:["Introduction","Theoretical Framework","Derivations","Predictions","Discussion","Conclusion"]},{n:"实验物理",s:["Introduction","Theoretical Background","Experimental Setup","Data Analysis","Results","Systematic Uncertainties","Conclusion"]},{n:"计算物理",s:["Introduction","Physical Model","Numerical Methods","Simulation Results","Validation","Conclusion"]},{n:"凝聚态",s:["Introduction","Model Hamiltonian","Methods","Results","Phase Diagram","Discussion","Conclusion"]},{n:"量子信息",s:["Introduction","Preliminaries","Protocol Design","Security Analysis","Implementation","Conclusion"]}]},
  {id:"education",label:"教育",icon:"📖",color:"#f43f5e",journals:["J. Educational Psychology","Studies in Higher Education","Teaching & Teacher Education"],sections:["Introduction","Literature Review","Theoretical Framework","Methodology","Findings","Discussion","Conclusion"],style:"Empirical-qualitative.",tp:[{n:"实证研究",s:["Introduction","Literature Review","Theoretical Framework","Methodology","Results","Discussion","Implications","Conclusion"]},{n:"课程设计",s:["Introduction","Needs Assessment","Design Framework","Implementation","Evaluation","Lessons Learned","Conclusion"]},{n:"教育技术",s:["Introduction","Literature Review","Technology Design","Study Design","Results","Discussion","Conclusion"]},{n:"教师发展",s:["Introduction","Background","Professional Development Model","Data Collection","Findings","Discussion","Implications"]},{n:"教育政策",s:["Introduction","Policy Context","Analytical Framework","Data and Methods","Findings","Policy Implications","Conclusion"]}]},
  {id:"psychology",label:"心理学",icon:"ψ",color:"#d946ef",journals:["Psychological Review","J. Personality & Social Psychology","Phil. Psychology"],sections:["Introduction","Literature Review","Theoretical Framework","Method","Results","Discussion","Conclusion"],style:"Empirical-APA.",tp:[{n:"实验心理",s:["Introduction","Method","Participants","Materials","Procedure","Results","Discussion","Conclusion"]},{n:"临床心理",s:["Introduction","Literature Review","Method","Participants","Measures","Results","Clinical Implications","Conclusion"]},{n:"发展心理",s:["Introduction","Theoretical Background","Method","Participants","Procedure","Results","Discussion","Conclusion"]},{n:"社会心理",s:["Introduction","Theoretical Framework","Study 1","Study 2","General Discussion","Conclusion"]},{n:"认知心理",s:["Introduction","Background","Experiment 1","Experiment 2","Computational Model","General Discussion","Conclusion"]}]},
  {id:"economics",label:"经济学",icon:"📊",color:"#f59e0b",journals:["Amer. Econ. Review","Econometrica","J. Political Economy"],sections:["Introduction","Literature Review","Model","Data","Empirical Results","Robustness","Conclusion"],style:"Model-data-regression.",tp:[{n:"计量经济",s:["Introduction","Literature Review","Theoretical Model","Data","Empirical Strategy","Results","Robustness Checks","Conclusion"]},{n:"理论模型",s:["Introduction","Model Setup","Equilibrium Analysis","Comparative Statics","Welfare Analysis","Conclusion"]},{n:"实验经济",s:["Introduction","Experimental Design","Procedures","Results","Structural Estimation","Discussion","Conclusion"]},{n:"发展经济",s:["Introduction","Context","Identification Strategy","Data","Results","Mechanisms","Policy Implications","Conclusion"]},{n:"行为经济",s:["Introduction","Theoretical Framework","Experimental Design","Results","Behavioral Model","Discussion","Conclusion"]}]},
  {id:"law",label:"法学",icon:"⚖",color:"#78716c",journals:["Harvard Law Review","Yale Law Journal","J. Legal Studies"],sections:["Introduction","Legal Background","Analysis","Comparative Study","Reform Proposals","Conclusion"],style:"Case-analysis-doctrine.",tp:[{n:"法教义学",s:["Introduction","Legal Framework","Doctrinal Analysis","Case Law Review","Critical Assessment","Reform Proposals","Conclusion"]},{n:"比较法",s:["Introduction","Jurisdiction A","Jurisdiction B","Comparative Analysis","Lessons and Transplantability","Conclusion"]},{n:"法社会学",s:["Introduction","Theoretical Framework","Methodology","Empirical Findings","Legal Implications","Conclusion"]},{n:"国际法",s:["Introduction","Legal Background","State Practice","Treaty Analysis","Customary Law","Assessment","Conclusion"]},{n:"法经济学",s:["Introduction","Economic Model","Legal Application","Empirical Evidence","Efficiency Analysis","Policy Recommendations","Conclusion"]}]},
  {id:"sociology",label:"社会学",icon:"👥",color:"#ec4899",journals:["Amer. Sociological Review","British J. Sociology","Social Forces"],sections:["Introduction","Literature Review","Theoretical Framework","Data & Methods","Findings","Discussion","Conclusion"],style:"Empirical-critical.",tp:[{n:"定量研究",s:["Introduction","Literature Review","Theory and Hypotheses","Data and Methods","Results","Discussion","Conclusion"]},{n:"质性研究",s:["Introduction","Literature Review","Methodology","Findings","Analysis","Discussion","Conclusion"]},{n:"混合方法",s:["Introduction","Theoretical Framework","Quantitative Phase","Qualitative Phase","Integration","Discussion","Conclusion"]},{n:"历史社会学",s:["Introduction","Historical Context","Theoretical Framework","Comparative Analysis","Mechanisms","Discussion","Conclusion"]},{n:"网络分析",s:["Introduction","Theoretical Background","Data and Network Construction","Network Analysis","Results","Discussion","Conclusion"]}]},
  {id:"biology",label:"生物学",icon:"🧬",color:"#22c55e",journals:["Nature","Cell","PNAS"],sections:["Introduction","Results","Discussion","Methods"],style:"Results-first-methods-last.",tp:[{n:"实验论文",s:["Introduction","Materials and Methods","Results","Discussion","Conclusion"]},{n:"基因组学",s:["Introduction","Materials and Methods","Genome Assembly","Annotation","Comparative Analysis","Discussion"]},{n:"生态研究",s:["Introduction","Study Site","Methods","Results","Ecological Implications","Discussion","Conclusion"]},{n:"分子生物",s:["Introduction","Materials and Methods","Results","Mechanistic Model","Discussion"]},{n:"综述文章",s:["Introduction","Scope and Methods","Thematic Analysis","Emerging Trends","Future Directions","Conclusion"]}]},
  {id:"medicine",label:"医学",icon:"⚕",color:"#ef4444",journals:["The Lancet","NEJM","BMJ"],sections:["Introduction","Methods","Results","Discussion","Conclusion"],style:"IMRAD clinical.",tp:[{n:"临床试验",s:["Introduction","Methods","Study Design","Participants","Interventions","Outcomes","Results","Discussion","Conclusion"]},{n:"观察研究",s:["Introduction","Methods","Study Population","Variables","Statistical Analysis","Results","Discussion","Conclusion"]},{n:"系统综述",s:["Introduction","Methods","Search Strategy","Study Selection","Data Extraction","Results","Discussion","Conclusion"]},{n:"病例报告",s:["Introduction","Case Presentation","Investigations","Differential Diagnosis","Treatment","Outcome","Discussion"]},{n:"诊断研究",s:["Introduction","Methods","Reference Standard","Index Test","Statistical Analysis","Results","Discussion","Conclusion"]}]},
  {id:"chemistry",label:"化学",icon:"⚗",color:"#a855f7",journals:["J. Amer. Chem. Soc.","Angew. Chem.","Nature Chemistry"],sections:["Introduction","Results and Discussion","Experimental","Conclusion"],style:"Results-discussion-experimental.",tp:[{n:"合成方法",s:["Introduction","Results and Discussion","Mechanistic Studies","Scope and Limitations","Experimental Section","Conclusion"]},{n:"分析化学",s:["Introduction","Experimental","Sensor Design","Calibration","Real Sample Analysis","Discussion","Conclusion"]},{n:"材料化学",s:["Introduction","Experimental","Synthesis","Characterization","Properties","Application","Conclusion"]},{n:"计算化学",s:["Introduction","Computational Methods","Results","Energy Analysis","Discussion","Conclusion"]},{n:"电化学",s:["Introduction","Experimental","Electrode Preparation","Electrochemical Measurements","Performance Analysis","Conclusion"]}]},
  {id:"engineering",label:"工程",icon:"⚙",color:"#64748b",journals:["IEEE Trans.","J. Eng. Mech.","Eng. Structures"],sections:["Introduction","Literature Review","Methodology","Design","Validation","Conclusion"],style:"Design-validation.",tp:[{n:"设计论文",s:["Introduction","Requirements","Design Methodology","Implementation","Testing","Performance Evaluation","Conclusion"]},{n:"实验论文",s:["Introduction","Background","Experimental Setup","Test Procedures","Results","Analysis","Conclusion"]},{n:"仿真论文",s:["Introduction","Mathematical Model","Numerical Method","Simulation Setup","Results","Validation","Conclusion"]},{n:"综述论文",s:["Introduction","Classification","State of the Art","Comparison","Challenges","Future Directions","Conclusion"]},{n:"优化设计",s:["Introduction","Problem Definition","Optimization Framework","Constraints","Results","Sensitivity Analysis","Conclusion"]}]},
  {id:"linguistics",label:"语言学",icon:"🔤",color:"#14b8a6",journals:["Language","Linguistics","J. Linguistics"],sections:["Introduction","Theoretical Background","Data","Analysis","Discussion","Conclusion"],style:"Data-analysis-theoretical.",tp:[{n:"语料分析",s:["Introduction","Theoretical Framework","Data and Corpus","Methodology","Results","Discussion","Conclusion"]},{n:"句法研究",s:["Introduction","Theoretical Background","Data","Analysis","Derivation","Predictions","Conclusion"]},{n:"语用学",s:["Introduction","Theoretical Framework","Data Collection","Analysis","Pragmatic Implications","Discussion","Conclusion"]},{n:"社会语言",s:["Introduction","Community Profile","Methodology","Variable Analysis","Social Factors","Discussion","Conclusion"]},{n:"语言习得",s:["Introduction","Literature Review","Participants","Materials","Procedure","Results","Discussion","Conclusion"]}]},
  {id:"management",label:"管理学",icon:"📋",color:"#0ea5e9",journals:["Acad. Management Review","Strategic Mgmt J.","MIS Quarterly"],sections:["Introduction","Theory & Hypotheses","Method","Results","Discussion","Conclusion"],style:"Hypothesis-testing.",tp:[{n:"实证研究",s:["Introduction","Theory and Hypotheses","Method","Sample and Data","Measures","Results","Discussion","Conclusion"]},{n:"案例研究",s:["Introduction","Theoretical Framework","Methodology","Case Description","Analysis","Discussion","Implications","Conclusion"]},{n:"元分析",s:["Introduction","Theoretical Background","Method","Literature Search","Coding","Results","Discussion","Conclusion"]},{n:"概念论文",s:["Introduction","Literature Review","Theoretical Development","Propositions","Discussion","Implications","Conclusion"]},{n:"创业研究",s:["Introduction","Literature Review","Theoretical Model","Data and Methods","Results","Discussion","Practical Implications","Conclusion"]}]},
  {id:"political",label:"政治学",icon:"🏛",color:"#b45309",journals:["Amer. Political Science Review","World Politics","Comparative Politics"],sections:["Introduction","Literature Review","Theory","Research Design","Analysis","Conclusion"],style:"Theory-case-analysis.",tp:[{n:"比较政治",s:["Introduction","Theoretical Framework","Case Selection","Methodology","Comparative Analysis","Discussion","Conclusion"]},{n:"国际关系",s:["Introduction","Theoretical Background","Research Design","Empirical Analysis","Results","Discussion","Conclusion"]},{n:"政治理论",s:["Introduction","Intellectual Context","The Argument","Critical Assessment","Normative Implications","Conclusion"]},{n:"公共政策",s:["Introduction","Policy Background","Analytical Framework","Data and Methods","Findings","Policy Implications","Conclusion"]},{n:"选举研究",s:["Introduction","Institutional Context","Data","Methodology","Results","Robustness","Discussion","Conclusion"]}]},
  {id:"history",label:"历史学",icon:"📜",color:"#a16207",journals:["Amer. Historical Review","Past & Present","J. Modern History"],sections:["Introduction","Historical Context","Sources","Analysis","Interpretation","Conclusion"],style:"Narrative-archival.",tp:[{n:"档案研究",s:["Introduction","Historiographical Context","Sources and Methods","Narrative Analysis","Interpretation","Conclusion"]},{n:"社会史",s:["Introduction","Historical Context","Sources","Social Analysis","Cultural Dimensions","Significance","Conclusion"]},{n:"思想史",s:["Introduction","Intellectual Context","Textual Analysis","Reception","Legacy","Conclusion"]},{n:"口述历史",s:["Introduction","Methodology","Interview Analysis","Thematic Findings","Memory and Narrative","Conclusion"]},{n:"全球史",s:["Introduction","Historiographical Framework","Connected Histories","Comparative Analysis","Transnational Dynamics","Conclusion"]}]},
  {id:"art",label:"艺术学",icon:"🎨",color:"#e11d48",journals:["Art Bulletin","J. Aesthetics","Leonardo"],sections:["Introduction","Aesthetic Context","Critical Analysis","SDE Reading","Implications","Conclusion"],style:"Critical-aesthetic.",tp:[{n:"艺术批评",s:["Introduction","Art Historical Context","Formal Analysis","Iconographic Reading","Critical Interpretation","Conclusion"]},{n:"艺术史",s:["Introduction","Historical Context","Visual Analysis","Patronage and Production","Reception","Conclusion"]},{n:"美学理论",s:["Introduction","Theoretical Background","Conceptual Analysis","Case Studies","Philosophical Implications","Conclusion"]},{n:"策展研究",s:["Introduction","Exhibition Context","Curatorial Concept","Spatial Analysis","Visitor Experience","Conclusion"]},{n:"数字艺术",s:["Introduction","Technological Context","Artistic Framework","Creation Process","Critical Analysis","Conclusion"]}]},
  {id:"environment",label:"环境科学",icon:"🌍",color:"#16a34a",journals:["Nature Climate Change","Environ. Sci. & Tech.","Global Change Biology"],sections:["Introduction","Background","Methods","Results","Discussion","Policy Implications","Conclusion"],style:"Empirical-policy.",tp:[{n:"影响评价",s:["Introduction","Study Area","Methods","Environmental Baseline","Impact Analysis","Mitigation","Conclusion"]},{n:"气候研究",s:["Introduction","Data and Methods","Climate Analysis","Model Projections","Uncertainty","Discussion","Conclusion"]},{n:"污染治理",s:["Introduction","Background","Materials and Methods","Treatment Results","Mechanism","Cost Analysis","Conclusion"]},{n:"生态修复",s:["Introduction","Site Description","Restoration Design","Monitoring","Outcomes","Lessons Learned","Conclusion"]},{n:"环境政策",s:["Introduction","Policy Context","Analytical Framework","Stakeholder Analysis","Policy Evaluation","Recommendations","Conclusion"]}]},
  {id:"communication",label:"传播学",icon:"📡",color:"#7c3aed",journals:["J. Communication","New Media & Society","Communication Research"],sections:["Introduction","Literature Review","Theoretical Framework","Method","Results","Discussion","Conclusion"],style:"Mixed-methods.",tp:[{n:"媒体分析",s:["Introduction","Theoretical Framework","Methodology","Textual Analysis","Findings","Discussion","Conclusion"]},{n:"受众研究",s:["Introduction","Literature Review","Method","Sample","Data Collection","Results","Discussion","Conclusion"]},{n:"数字传播",s:["Introduction","Platform Context","Theoretical Framework","Data and Methods","Results","Discussion","Conclusion"]},{n:"政治传播",s:["Introduction","Theoretical Background","Research Design","Content Analysis","Effects Analysis","Discussion","Conclusion"]},{n:"健康传播",s:["Introduction","Background","Campaign Design","Methodology","Results","Behavioral Outcomes","Conclusion"]}]},
  {id:"data",label:"数据科学",icon:"📈",color:"#0891b2",journals:["J. Machine Learning Research","Data Mining & Knowledge Discovery","Big Data"],sections:["Introduction","Related Work","Problem Formulation","Method","Experiments","Results","Conclusion"],style:"Problem-method-experiment.",tp:[{n:"机器学习",s:["Introduction","Related Work","Problem Formulation","Method","Experiments","Results","Conclusion"]},{n:"数据挖掘",s:["Introduction","Related Work","Data Description","Mining Algorithm","Evaluation","Case Study","Conclusion"]},{n:"可视化",s:["Introduction","Related Work","Design Rationale","System Design","User Study","Results","Conclusion"]},{n:"大数据分析",s:["Introduction","Background","Data Pipeline","Analytical Framework","Results","Scalability","Conclusion"]},{n:"隐私安全",s:["Introduction","Threat Model","Proposed Method","Security Analysis","Experimental Evaluation","Discussion","Conclusion"]}]},
  {id:"religion",label:"宗教学",icon:"☯",color:"#854d0e",journals:["J. Religion","Religious Studies","Theology Today"],sections:["Introduction","Textual Analysis","Theological Framework","Comparative Study","Hermeneutic Discussion","Conclusion"],style:"Hermeneutic-comparative.",tp:[{n:"经典诠释",s:["Introduction","Textual Context","Philological Analysis","Theological Interpretation","Comparative Reading","Conclusion"]},{n:"宗教社会学",s:["Introduction","Theoretical Framework","Methodology","Findings","Sociological Analysis","Conclusion"]},{n:"比较宗教",s:["Introduction","Tradition A","Tradition B","Comparative Analysis","Theological Implications","Conclusion"]},{n:"宗教哲学",s:["Introduction","The Problem","Classical Arguments","Contemporary Approaches","A New Proposal","Conclusion"]},{n:"宗教人类学",s:["Introduction","Ethnographic Context","Fieldwork Methods","Ritual Analysis","Cultural Interpretation","Conclusion"]}]},
  {id:"anthro",label:"人类学",icon:"🌐",color:"#c2410c",journals:["Amer. Anthropologist","Annual Review of Anthropology","Current Anthropology"],sections:["Introduction","Ethnographic Context","Fieldwork Methods","Findings","Analysis","Discussion","Conclusion"],style:"Ethnographic-interpretive.",tp:[{n:"民族志",s:["Introduction","Field Site","Methodology","Ethnographic Description","Thematic Analysis","Discussion","Conclusion"]},{n:"考古人类学",s:["Introduction","Site Context","Methods","Material Analysis","Cultural Interpretation","Discussion","Conclusion"]},{n:"语言人类学",s:["Introduction","Community Context","Language Practices","Discourse Analysis","Sociocultural Implications","Conclusion"]},{n:"医学人类学",s:["Introduction","Theoretical Framework","Fieldwork","Illness Narratives","Biomedical Encounter","Discussion","Conclusion"]},{n:"视觉人类学",s:["Introduction","Visual Methods","Image Analysis","Representation","Reflexivity","Conclusion"]}]},
  {id:"geography",label:"地理学",icon:"🗺",color:"#15803d",journals:["Annals of the AAG","Progress in Human Geography","Geomorphology"],sections:["Introduction","Study Area","Data & Methods","Results","Discussion","Conclusion"],style:"Spatial-empirical.",tp:[{n:"自然地理",s:["Introduction","Study Area","Methods","Geomorphological Analysis","Results","Discussion","Conclusion"]},{n:"人文地理",s:["Introduction","Conceptual Framework","Methodology","Spatial Analysis","Findings","Discussion","Conclusion"]},{n:"GIS应用",s:["Introduction","Study Area","Data Sources","GIS Methods","Spatial Analysis","Results","Conclusion"]},{n:"城市地理",s:["Introduction","Urban Context","Theoretical Framework","Spatial Data","Analysis","Planning Implications","Conclusion"]},{n:"政治地理",s:["Introduction","Geopolitical Context","Theoretical Framework","Territorial Analysis","Discussion","Conclusion"]}]},
  {id:"arch",label:"建筑学",icon:"🏗",color:"#9a3412",journals:["Architectural Research Quarterly","J. Architecture","Building & Environment"],sections:["Introduction","Design Context","Theoretical Framework","Case Analysis","Design Proposal","Evaluation","Conclusion"],style:"Design-case-proposal.",tp:[{n:"建筑设计",s:["Introduction","Design Context","Conceptual Framework","Design Development","Construction","Post-Occupancy","Conclusion"]},{n:"建筑历史",s:["Introduction","Historical Context","Building Analysis","Stylistic Development","Cultural Significance","Conclusion"]},{n:"可持续建筑",s:["Introduction","Sustainability Framework","Design Strategies","Performance Simulation","Monitoring Results","Conclusion"]},{n:"城市设计",s:["Introduction","Site Analysis","Design Principles","Master Plan","Public Space","Implementation","Conclusion"]},{n:"建筑技术",s:["Introduction","Technical Background","Material Properties","Structural Analysis","Performance Testing","Conclusion"]}]},
  {id:"music",label:"音乐学",icon:"🎵",color:"#7e22ce",journals:["J. Music Theory","Music Perception","Musicology Today"],sections:["Introduction","Musical Context","Analytical Framework","Analysis","Interpretation","Conclusion"],style:"Analytical-interpretive.",tp:[{n:"音乐分析",s:["Introduction","Analytical Framework","Score Analysis","Harmonic Structure","Formal Design","Conclusion"]},{n:"音乐史",s:["Introduction","Historical Context","Source Analysis","Stylistic Development","Reception History","Conclusion"]},{n:"民族音乐",s:["Introduction","Cultural Context","Fieldwork","Musical Analysis","Social Function","Conclusion"]},{n:"音乐教育",s:["Introduction","Pedagogical Framework","Study Design","Data Collection","Results","Implications","Conclusion"]},{n:"音乐心理",s:["Introduction","Theoretical Background","Method","Stimuli","Results","Discussion","Conclusion"]}]},
  {id:"film",label:"影视学",icon:"🎬",color:"#be123c",journals:["Screen","Film Quarterly","Cinema Journal"],sections:["Introduction","Film Context","Theoretical Framework","Textual Analysis","Cultural Reading","Conclusion"],style:"Critical-textual.",tp:[{n:"电影分析",s:["Introduction","Theoretical Framework","Textual Analysis","Cinematographic Analysis","Thematic Interpretation","Conclusion"]},{n:"电影史",s:["Introduction","Historical Context","Industrial Analysis","Aesthetic Development","Cultural Impact","Conclusion"]},{n:"纪录片",s:["Introduction","Documentary Theory","Production Context","Representational Analysis","Ethics","Conclusion"]},{n:"电影产业",s:["Introduction","Market Context","Industry Structure","Distribution Analysis","Audience Reception","Conclusion"]},{n:"跨媒介",s:["Introduction","Media Ecology","Narrative Analysis","Platform Comparison","Convergence","Conclusion"]}]},
  {id:"sport",label:"体育学",icon:"⚽",color:"#ea580c",journals:["British J. Sports Medicine","J. Sport Sciences","Medicine & Science in Sports"],sections:["Introduction","Literature Review","Methods","Results","Discussion","Practical Applications","Conclusion"],style:"Empirical-applied.",tp:[{n:"运动生理",s:["Introduction","Literature Review","Methods","Participants","Protocol","Results","Discussion","Conclusion"]},{n:"运动心理",s:["Introduction","Theoretical Framework","Method","Participants","Measures","Results","Discussion","Conclusion"]},{n:"运动管理",s:["Introduction","Literature Review","Theoretical Model","Methodology","Results","Managerial Implications","Conclusion"]},{n:"运动生物力学",s:["Introduction","Background","Methods","Motion Analysis","Force Analysis","Results","Discussion","Conclusion"]},{n:"体育教育",s:["Introduction","Curriculum Context","Pedagogical Model","Study Design","Results","Discussion","Conclusion"]}]},
  {id:"agri",label:"农学",icon:"🌾",color:"#4d7c0f",journals:["Nature Food","Agricultural Systems","Agronomy J."],sections:["Introduction","Materials & Methods","Results","Discussion","Implications","Conclusion"],style:"Field-experiment.",tp:[{n:"作物科学",s:["Introduction","Materials and Methods","Field Design","Growth Analysis","Yield Results","Discussion","Conclusion"]},{n:"土壤科学",s:["Introduction","Study Site","Soil Sampling","Laboratory Analysis","Results","Discussion","Conclusion"]},{n:"农业经济",s:["Introduction","Market Context","Data","Econometric Model","Results","Policy Implications","Conclusion"]},{n:"畜牧研究",s:["Introduction","Materials and Methods","Animal Management","Performance Data","Results","Discussion","Conclusion"]},{n:"农业技术",s:["Introduction","Technology Description","Field Trial","Performance Evaluation","Economic Analysis","Conclusion"]}]},
  {id:"pharma",label:"药学",icon:"💊",color:"#dc2626",journals:["Nature Reviews Drug Discovery","J. Medicinal Chemistry","Pharmaceutical Research"],sections:["Introduction","Drug Design","Synthesis","Biological Evaluation","Pharmacokinetics","Discussion","Conclusion"],style:"Design-synthesis-evaluation.",tp:[{n:"药物发现",s:["Introduction","Target Identification","Compound Design","In Vitro Assays","In Vivo Studies","Discussion","Conclusion"]},{n:"药代动力学",s:["Introduction","Materials and Methods","PK Study Design","Bioanalysis","PK Parameters","Discussion","Conclusion"]},{n:"制剂研究",s:["Introduction","Materials","Formulation Development","Characterization","In Vitro Release","Stability","Conclusion"]},{n:"临床药理",s:["Introduction","Study Design","Subjects","Drug Administration","PK/PD Analysis","Safety","Conclusion"]},{n:"天然产物",s:["Introduction","Plant Material","Extraction","Structure Elucidation","Bioactivity","Discussion","Conclusion"]}]},
  {id:"neuro",label:"神经科学",icon:"🧠",color:"#4f46e5",journals:["Nature Neuroscience","Neuron","Brain"],sections:["Introduction","Results","Discussion","Methods"],style:"Results-first-methods-last.",tp:[{n:"认知神经",s:["Introduction","Background","Methods","Participants","Neuroimaging","Results","Discussion","Conclusion"]},{n:"计算神经",s:["Introduction","Neural Model","Mathematical Analysis","Simulations","Experimental Comparison","Discussion","Conclusion"]},{n:"临床神经",s:["Introduction","Patient Population","Methods","Neurological Assessment","Results","Clinical Implications","Conclusion"]},{n:"神经影像",s:["Introduction","Methods","Participants","Image Acquisition","Data Analysis","Results","Discussion","Conclusion"]},{n:"神经发育",s:["Introduction","Background","Cohort","Developmental Assessment","Longitudinal Analysis","Discussion","Conclusion"]}]},
  {id:"eco",label:"生态学",icon:"🦋",color:"#059669",journals:["Ecology","Ecological Monographs","Trends in Ecology & Evolution"],sections:["Introduction","Study System","Methods","Results","Discussion","Conservation Implications","Conclusion"],style:"System-empirical.",tp:[{n:"群落生态",s:["Introduction","Study Site","Methods","Species Analysis","Community Structure","Discussion","Conclusion"]},{n:"保护生态",s:["Introduction","Species Background","Threat Assessment","Conservation Strategy","Monitoring","Effectiveness","Conclusion"]},{n:"景观生态",s:["Introduction","Study Area","Landscape Metrics","Spatial Analysis","Connectivity","Discussion","Conclusion"]},{n:"生态建模",s:["Introduction","Model Description","Parameterization","Simulation","Sensitivity Analysis","Discussion","Conclusion"]},{n:"海洋生态",s:["Introduction","Study Area","Sampling Methods","Species Composition","Environmental Drivers","Discussion","Conclusion"]}]},
  {id:"astro",label:"天文学",icon:"🔭",color:"#1d4ed8",journals:["Astrophysical Journal","Monthly Notices of RAS","Astronomy & Astrophysics"],sections:["Introduction","Observations","Data Reduction","Analysis","Results","Discussion","Conclusion"],style:"Observational-analytical.",tp:[{n:"观测天文",s:["Introduction","Observations","Data Reduction","Analysis","Results","Discussion","Conclusion"]},{n:"理论天体",s:["Introduction","Physical Model","Analytical Solutions","Numerical Simulations","Predictions","Conclusion"]},{n:"行星科学",s:["Introduction","Planetary Context","Observations","Atmospheric Analysis","Interior Models","Discussion","Conclusion"]},{n:"宇宙学",s:["Introduction","Theoretical Framework","Observational Data","Statistical Analysis","Cosmological Parameters","Discussion","Conclusion"]},{n:"高能天体",s:["Introduction","Source Description","Observations","Spectral Analysis","Physical Interpretation","Conclusion"]}]},
  {id:"materials",label:"材料学",icon:"🔬",color:"#7c3aed",journals:["Nature Materials","Advanced Materials","Acta Materialia"],sections:["Introduction","Experimental","Results and Discussion","Characterization","Performance","Conclusion"],style:"Synthesis-characterization.",tp:[{n:"材料合成",s:["Introduction","Experimental","Synthesis","Characterization","Properties","Application","Conclusion"]},{n:"材料计算",s:["Introduction","Computational Methods","Model Setup","Results","Property Prediction","Discussion","Conclusion"]},{n:"纳米材料",s:["Introduction","Synthesis","Morphological Characterization","Property Measurement","Application","Discussion","Conclusion"]},{n:"生物材料",s:["Introduction","Materials","Fabrication","Biocompatibility","In Vivo Study","Discussion","Conclusion"]},{n:"功能材料",s:["Introduction","Design Concept","Fabrication","Functional Characterization","Device Performance","Conclusion"]}]},
  {id:"energy",label:"能源学",icon:"⚡",color:"#ca8a04",journals:["Nature Energy","Energy & Environmental Science","Renewable Energy"],sections:["Introduction","System Design","Methodology","Results","Performance Analysis","Sustainability Assessment","Conclusion"],style:"Design-performance-sustainability.",tp:[{n:"太阳能",s:["Introduction","Device Design","Fabrication","Characterization","Performance","Stability","Conclusion"]},{n:"储能技术",s:["Introduction","Materials","Electrode Preparation","Electrochemical Testing","Cycling Performance","Mechanism","Conclusion"]},{n:"风能研究",s:["Introduction","Wind Resource","Turbine Design","Simulation","Field Data","Performance Analysis","Conclusion"]},{n:"氢能燃料",s:["Introduction","Catalyst Design","Preparation","Electrochemical Testing","Durability","Discussion","Conclusion"]},{n:"能源政策",s:["Introduction","Policy Context","Analytical Framework","Scenario Analysis","Economic Assessment","Policy Recommendations","Conclusion"]}]},
  {id:"urban",label:"城市学",icon:"🏙",color:"#475569",journals:["Urban Studies","Cities","J. Urban Economics"],sections:["Introduction","Urban Context","Theoretical Framework","Data & Methods","Findings","Policy Implications","Conclusion"],style:"Empirical-policy.",tp:[{n:"城市规划",s:["Introduction","Planning Context","Theoretical Framework","Case Analysis","Spatial Strategies","Implementation","Conclusion"]},{n:"智慧城市",s:["Introduction","Technology Framework","System Architecture","Implementation","Performance Evaluation","Discussion","Conclusion"]},{n:"交通规划",s:["Introduction","Transport Context","Data Collection","Modeling","Scenario Analysis","Policy Implications","Conclusion"]},{n:"社区发展",s:["Introduction","Community Profile","Participatory Methods","Needs Assessment","Intervention Design","Outcomes","Conclusion"]},{n:"城市更新",s:["Introduction","Historical Context","Regeneration Strategy","Stakeholder Analysis","Implementation","Impact Assessment","Conclusion"]}]},
  {id:"info",label:"信息学",icon:"💻",color:"#0284c7",journals:["J. Information Science","Information Systems Research","MIS Quarterly"],sections:["Introduction","Literature Review","Research Model","Methodology","Results","Discussion","Conclusion"],style:"Model-survey-analysis.",tp:[{n:"信息检索",s:["Introduction","Related Work","Method","Dataset","Experiments","Results","Conclusion"]},{n:"知识管理",s:["Introduction","Theoretical Framework","Research Design","Data Collection","Analysis","Discussion","Conclusion"]},{n:"人机交互",s:["Introduction","Related Work","Design Process","Prototype","User Study","Results","Discussion","Conclusion"]},{n:"数字图书馆",s:["Introduction","System Requirements","Architecture","Implementation","Evaluation","User Feedback","Conclusion"]},{n:"信息行为",s:["Introduction","Literature Review","Theoretical Model","Methodology","Findings","Discussion","Conclusion"]}]},
  {id:"design",label:"设计学",icon:"✏️",color:"#db2777",journals:["Design Studies","Design Issues","International J. Design"],sections:["Introduction","Design Context","Design Process","Prototype","User Evaluation","Reflection","Conclusion"],style:"Practice-based-reflective.",tp:[{n:"用户体验",s:["Introduction","User Research","Design Process","Prototyping","Usability Testing","Findings","Conclusion"]},{n:"服务设计",s:["Introduction","Service Context","Design Thinking","Journey Mapping","Prototyping","Evaluation","Conclusion"]},{n:"工业设计",s:["Introduction","Design Brief","Concept Development","Material Selection","Manufacturing","Evaluation","Conclusion"]},{n:"交互设计",s:["Introduction","Related Work","Design Framework","Implementation","User Study","Results","Conclusion"]},{n:"设计理论",s:["Introduction","Theoretical Background","Conceptual Framework","Case Studies","Design Principles","Conclusion"]}]},
  {id:"food",label:"食品科学",icon:"🍽",color:"#b91c1c",journals:["Food Chemistry","J. Food Science","Trends in Food Science & Technology"],sections:["Introduction","Materials & Methods","Results","Discussion","Quality Assessment","Conclusion"],style:"Experimental-quality.",tp:[{n:"食品化学",s:["Introduction","Materials and Methods","Chemical Analysis","Results","Nutritional Assessment","Discussion","Conclusion"]},{n:"食品工程",s:["Introduction","Materials","Process Design","Optimization","Product Characterization","Conclusion"]},{n:"食品安全",s:["Introduction","Hazard Identification","Methodology","Microbiological Analysis","Risk Assessment","Conclusion"]},{n:"食品感官",s:["Introduction","Materials","Panel Selection","Sensory Evaluation","Statistical Analysis","Discussion","Conclusion"]},{n:"功能食品",s:["Introduction","Active Compounds","Extraction","Bioactivity","Formulation","Health Claims","Conclusion"]}]},
  {id:"nursing",label:"护理学",icon:"🏥",color:"#e11d48",journals:["J. Advanced Nursing","Nursing Research","International J. Nursing Studies"],sections:["Introduction","Background","Methods","Findings","Discussion","Implications for Practice","Conclusion"],style:"Clinical-qualitative.",tp:[{n:"临床护理",s:["Introduction","Background","Methods","Study Design","Data Collection","Results","Nursing Implications","Conclusion"]},{n:"护理教育",s:["Introduction","Educational Framework","Curriculum Design","Implementation","Student Outcomes","Discussion","Conclusion"]},{n:"社区护理",s:["Introduction","Community Assessment","Intervention Design","Implementation","Health Outcomes","Discussion","Conclusion"]},{n:"护理管理",s:["Introduction","Organizational Context","Theoretical Framework","Study Design","Findings","Management Implications","Conclusion"]},{n:"循证护理",s:["Introduction","Clinical Question","Search Strategy","Critical Appraisal","Evidence Synthesis","Practice Recommendations","Conclusion"]}]},
  {id:"tourism",label:"旅游学",icon:"✈️",color:"#0d9488",journals:["Tourism Management","Annals of Tourism Research","J. Travel Research"],sections:["Introduction","Literature Review","Conceptual Framework","Methodology","Results","Discussion","Managerial Implications","Conclusion"],style:"Framework-survey-implications.",tp:[{n:"旅游行为",s:["Introduction","Literature Review","Conceptual Model","Methodology","Results","Discussion","Implications","Conclusion"]},{n:"目的地管理",s:["Introduction","Destination Context","Theoretical Framework","Methodology","Findings","Governance Implications","Conclusion"]},{n:"遗产旅游",s:["Introduction","Heritage Context","Theoretical Framework","Case Study","Visitor Experience","Authenticity","Conclusion"]},{n:"可持续旅游",s:["Introduction","Sustainability Framework","Study Area","Methodology","Impact Assessment","Management Strategies","Conclusion"]},{n:"数字旅游",s:["Introduction","Technology Context","Platform Analysis","User Behavior","Data Analytics","Implications","Conclusion"]}]},
  {id:"semiotics",label:"符号学",icon:"🔣",color:"#7c3aed",journals:["Semiotica","Sign Systems Studies","Social Semiotics"],sections:["Introduction","Semiotic Framework","Sign Analysis","Interpretive Analysis","Discussion","Conclusion"],style:"Peircean/Saussurean analysis.",tp:[{n:"符号分析",s:["Introduction","Semiotic Framework","Sign System Description","Analysis","Interpretation","Conclusion"]},{n:"多模态话语",s:["Introduction","Multimodal Theory","Corpus Description","Intersemiotic Analysis","Findings","Discussion","Conclusion"]},{n:"文化符号学",s:["Introduction","Cultural Context","Semiotic Resources","Mythological Analysis","Cultural Dynamics","Conclusion"]},{n:"视觉符号学",s:["Introduction","Visual Grammar","Image Corpus","Compositional Analysis","Ideational Meaning","Conclusion"]},{n:"数字符号学",s:["Introduction","Digital Sign Systems","Platform Analysis","User-Generated Signs","Semiotic Innovation","Conclusion"]}]},
  {id:"ethics",label:"伦理道德",icon:"⚖️",color:"#b45309",journals:["Ethics","J. Applied Philosophy","Philosophy & Public Affairs"],sections:["Introduction","Moral Framework","Argument","Objections","Implications","Conclusion"],style:"Normative argument.",tp:[{n:"规范论证",s:["Introduction","Moral Framework","Central Argument","Objections and Replies","Implications","Conclusion"]},{n:"应用伦理",s:["Introduction","Case Description","Ethical Analysis","Stakeholder Perspectives","Policy Implications","Conclusion"]},{n:"元伦理学",s:["Introduction","Metaethical Background","Conceptual Analysis","Arguments","Counterarguments","Conclusion"]},{n:"生命伦理",s:["Introduction","Medical Context","Ethical Framework","Case Analysis","Autonomy and Justice","Recommendations","Conclusion"]},{n:"技术伦理",s:["Introduction","Technology Description","Value Analysis","Risk Assessment","Design Principles","Governance","Conclusion"]}]},
  {id:"logic",label:"逻辑学",icon:"⊢",color:"#4338ca",journals:["J. Symbolic Logic","J. Philosophical Logic","Studia Logica"],sections:["Introduction","Formal Preliminaries","Main Results","Proofs","Semantic Analysis","Conclusion"],style:"Formal definitions, proof theory.",tp:[{n:"形式证明",s:["Introduction","Preliminaries","Definitions","Main Theorems","Proofs","Applications","Conclusion"]},{n:"逻辑哲学",s:["Introduction","Logical Background","Philosophical Argument","Formal Analysis","Implications","Conclusion"]},{n:"非经典逻辑",s:["Introduction","Classical Limitations","New System","Syntax and Semantics","Metatheorems","Applications","Conclusion"]},{n:"模态逻辑",s:["Introduction","Modal Framework","Kripke Semantics","Axiomatization","Completeness","Applications","Conclusion"]},{n:"逻辑与计算",s:["Introduction","Logical Foundation","Type Theory","Algorithm","Complexity Analysis","Implementation","Conclusion"]}]},
  {id:"military",label:"军事学",icon:"🎖️",color:"#991b1b",journals:["J. Strategic Studies","Military Operations Research","Defence Studies"],sections:["Introduction","Strategic Context","Framework","Case Analysis","Assessment","Implications","Conclusion"],style:"Strategy-operations-tactics.",tp:[{n:"战略分析",s:["Introduction","Strategic Environment","Theoretical Framework","Case Study","Assessment","Implications","Conclusion"]},{n:"军事技术",s:["Introduction","Technology Context","Capability Analysis","Operational Impact","Future Trajectory","Conclusion"]},{n:"军事史",s:["Introduction","Historical Context","Campaign Analysis","Lessons Learned","Contemporary Relevance","Conclusion"]},{n:"国防政策",s:["Introduction","Security Environment","Policy Framework","Capability Assessment","Budget Analysis","Recommendations","Conclusion"]},{n:"军事战术",s:["Introduction","Operational Context","Doctrinal Framework","Tactical Analysis","Simulation","Lessons","Conclusion"]}]},
  {id:"archaeology",label:"考古学",icon:"🏺",color:"#78350f",journals:["American Antiquity","J. Archaeological Science","Antiquity"],sections:["Introduction","Background","Materials","Results","Interpretation","Discussion","Conclusion"],style:"Excavation data, stratigraphy.",tp:[{n:"遗址发掘",s:["Introduction","Site Context","Excavation Methods","Stratigraphy","Artifact Analysis","Interpretation","Conclusion"]},{n:"考古科技",s:["Introduction","Scientific Background","Materials","Analytical Methods","Results","Discussion","Conclusion"]},{n:"理论考古",s:["Introduction","Archaeological Theory","Case Studies","Reinterpretation","Critical Discussion","Conclusion"]},{n:"环境考古",s:["Introduction","Environmental Context","Sampling","Paleoecological Analysis","Human-Environment Interaction","Conclusion"]},{n:"数字考古",s:["Introduction","Digital Methods","Data Acquisition","3D Modeling","Spatial Analysis","Interpretation","Conclusion"]}]},
  {id:"translation",label:"翻译学",icon:"🌐",color:"#0369a1",journals:["Target","The Translator","Translation Studies"],sections:["Introduction","Framework","Source Text","Translation Analysis","Discussion","Conclusion"],style:"Translation theory, contrastive analysis.",tp:[{n:"翻译理论",s:["Introduction","Theoretical Background","Conceptual Framework","Case Analysis","Discussion","Conclusion"]},{n:"翻译实践",s:["Introduction","Source Text","Translation Strategy","Comparative Analysis","Quality Assessment","Conclusion"]},{n:"口译研究",s:["Introduction","Interpreting Theory","Methodology","Data Analysis","Cognitive Load","Conclusion"]},{n:"文学翻译",s:["Introduction","Source Text Analysis","Translation Approach","Stylistic Comparison","Cultural Mediation","Conclusion"]},{n:"机器翻译",s:["Introduction","System Architecture","Training Data","Evaluation Metrics","Human Evaluation","Error Analysis","Conclusion"]}]},
  {id:"criminology",label:"犯罪学",icon:"🔍",color:"#dc2626",journals:["Criminology","British J. Criminology","J. Criminal Justice"],sections:["Introduction","Literature","Framework","Methods","Results","Discussion","Policy","Conclusion"],style:"Criminological analysis.",tp:[{n:"犯罪理论",s:["Introduction","Theoretical Background","Conceptual Development","Empirical Evidence","Discussion","Conclusion"]},{n:"刑事司法",s:["Introduction","Justice System Context","Research Design","Data","Findings","Policy Implications","Conclusion"]},{n:"犯罪预防",s:["Introduction","Prevention Theory","Program Design","Evaluation Methods","Effectiveness","Recommendations","Conclusion"]},{n:"少年犯罪",s:["Introduction","Developmental Framework","Risk Factors","Study Design","Results","Intervention Implications","Conclusion"]},{n:"网络犯罪",s:["Introduction","Threat Landscape","Methodology","Case Analysis","Attribution","Countermeasures","Conclusion"]}]},
  {id:"socialwork",label:"社会工作",icon:"🤝",color:"#0891b2",journals:["Social Work","British J. Social Work","Social Service Review"],sections:["Introduction","Literature","Framework","Methodology","Findings","Implications","Conclusion"],style:"Practice-research integration.",tp:[{n:"实务研究",s:["Introduction","Literature Review","Theoretical Framework","Methods","Findings","Practice Implications","Conclusion"]},{n:"社会政策",s:["Introduction","Policy Context","Analytical Framework","Impact Analysis","Equity Assessment","Recommendations","Conclusion"]},{n:"社区发展",s:["Introduction","Community Context","Participatory Methods","Action Research","Outcomes","Empowerment Assessment","Conclusion"]},{n:"儿童福利",s:["Introduction","Policy Background","Risk Assessment","Study Design","Findings","Protective Factors","Implications"]},{n:"老年社工",s:["Introduction","Aging Context","Theoretical Framework","Needs Assessment","Intervention","Outcomes","Conclusion"]}]},
  {id:"tcm",label:"中医学",icon:"🌿",color:"#15803d",journals:["J. Ethnopharmacology","Chinese Medicine","J. Traditional Chinese Medicine"],sections:["Introduction","TCM Theory","Literature","Methods","Results","Mechanism","Implications","Conclusion"],style:"Syndrome differentiation, herbal formulation.",tp:[{n:"方剂研究",s:["Introduction","Formula Background","TCM Theory","Methods","Pharmacological Results","Mechanism","Clinical Relevance","Conclusion"]},{n:"经络腧穴",s:["Introduction","Meridian Theory","Acupoint Selection","Clinical Trial Design","Results","Mechanism Discussion","Conclusion"]},{n:"证候研究",s:["Introduction","Syndrome Theory","Diagnostic Criteria","Clinical Data","Pattern Analysis","Biological Basis","Conclusion"]},{n:"中药药理",s:["Introduction","Herbal Background","Active Compounds","Experimental Methods","Pharmacological Effects","Molecular Targets","Conclusion"]},{n:"中西医结合",s:["Introduction","Disease Background","TCM Perspective","Biomedical Perspective","Integrative Protocol","Clinical Evidence","Conclusion"]}]},
  {id:"theater",label:"戏剧学",icon:"🎭",color:"#a21caf",journals:["Theatre Journal","Theatre Research International","Modern Drama"],sections:["Introduction","Context","Framework","Performance Analysis","Reception","Discussion","Conclusion"],style:"Performance analysis, dramaturgy.",tp:[{n:"表演分析",s:["Introduction","Performance Context","Theoretical Lens","Staging Analysis","Body and Space","Reception","Conclusion"]},{n:"戏剧理论",s:["Introduction","Theoretical Background","Conceptual Development","Case Studies","Critical Analysis","Conclusion"]},{n:"应用戏剧",s:["Introduction","Community Context","Workshop Design","Process Documentation","Participant Outcomes","Reflection","Conclusion"]},{n:"导演研究",s:["Introduction","Director Profile","Production Context","Directorial Vision","Staging Decisions","Critical Reception","Conclusion"]},{n:"戏剧教育",s:["Introduction","Pedagogical Framework","Curriculum Design","Implementation","Student Learning","Assessment","Conclusion"]}]},
];

function matchDomain(j){
  if(!j)return"math";const l=j.toLowerCase();
  const map=[
    [["phil","kant","phenom","continental"],"philosophy"],
    [["siam","math","found. comput","adv. math"],"math"],
    [["cmame","comput. phys","mech","numer"],"cs"],
    [["neurips","icml","nature mi","machine intel"],"ai"],
    [["neuron","neurosci","brain"],"neuro"],
    [["phys. rev","nature phys","j. phys","astrophys"],"physics"],
    [["astrophys","monthly notices","astron"],"astro"],
    [["educ","teach","higher ed","learn"],"education"],
    [["psychol","personality","cognit"],"psychology"],
    [["econ","econom"],"economics"],
    [["law","legal","jurisprud"],"law"],
    [["sociol","social force"],"sociology"],
    [["nurs","j. adv. nurs"],"nursing"],
    [["lancet","nejm","bmj","medic","clinic"],"medicine"],
    [["pharma","drug discov","medicin. chem"],"pharma"],
    [["food chem","food sci","food"],"food"],
    [["nature mat","adv. mat","acta mat"],"materials"],
    [["chem","angew"],"chemistry"],
    [["ieee","eng struct"],"engineering"],
    [["architect","build"],"arch"],
    [["linguist","language"],"linguistics"],
    [["manage","strateg","mis q"],"management"],
    [["politic","world polit","compar"],"political"],
    [["histor","past & present"],"history"],
    [["art bull","aesthet","leonardo"],"art"],
    [["music","musicol"],"music"],
    [["screen","film","cinema"],"film"],
    [["sport","exerc"],"sport"],
    [["agri","agron","nature food"],"agri"],
    [["environ","climate"],"environment"],
    [["ecolog","conserv"],"eco"],
    [["energy","renewable","solar"],"energy"],
    [["urban","cities","city"],"urban"],
    [["commun","media","new media"],"communication"],
    [["inform. sci","inform. sys","mis quart"],"info"],
    [["design stud","design issue"],"design"],
    [["tourism","travel","hospit"],"tourism"],
    [["data","mining","big data"],"data"],
    [["anthropol","ethnogr"],"anthro"],
    [["geograph","geomorph","spatial"],"geography"],
    [["religion","theolog"],"religion"],
    [["nature","cell","pnas","bio"],"biology"],
    [["semiot","sign system","social semiot"],"semiotics"],
    [["ethics","moral","applied philos","public affairs"],"ethics"],
    [["symbolic logic","studia logica","j. philos. logic"],"logic"],
    [["strateg stud","military","defence"],"military"],
    [["antiquity","archaeol","j. archaeol"],"archaeology"],
    [["translat","target","interpret"],"translation"],
    [["criminol","criminal justice","crime"],"criminology"],
    [["social work","social service"],"socialwork"],
    [["ethnopharmacol","chinese med","tradit. chin"],"tcm"],
    [["theatre","theater","drama","modern drama"],"theater"],
  ];
  for(const[keys,id]of map){for(const k of keys){if(l.includes(k))return id;}}
  return"math";
}

// Backend proxy endpoints (key stays on server)
// - /api/ai       : GCG multi-provider (Gemini + Claude + GPT) — ONLY endpoint used in global edition
// - /api/deepseek : legacy path retained on backend for emergency fallback, NOT called by frontend
const DEEPSEEK_MODEL = "deepseek-chat";           // Reserved constant, no longer invoked by frontend
const DEEPSEEK_REASONER = "deepseek-reasoner";    // Reserved constant, no longer invoked by frontend
const API_ENDPOINT = "/api/deepseek";             // Kept for historical compatibility; frontend does not use
const API_ENDPOINT_MULTI = "/api/ai";

// GCG role → provider mapping (E1 = Gemini reality, E2 = Claude reasoning, E3 = GPT entanglement)
// Per the Dragon Claw constitution, overseas / GCG edition routes each role to its native provider.
const GCG_PROVIDER = {
  gemini:    null,   // uses provider default model (gemini-2.5-pro)
  anthropic: null,   // uses provider default model (claude-opus-4-7)
  openai:    null,   // uses provider default model (gpt-4.1)
};

// Fifth iron-law "meaning attraction" is served through a global system-prompt prefix
// injected by PAPER_SYS_CN; we do not expose it as a separate module.
//
// `provider` param: "anthropic" (default, Claude main workhorse) | "openai" (GPT) | "gemini" (Gemini)
// `tier`     param: "premium" | "balanced" | "economy" (optional)
//                   If omitted, Worker uses DEFAULT_MODELS (economy baseline).
// `student_code` is auto-injected from window.__SDE_STUDENT_CODE (set by StudentPanel component)
// All requests route to /api/ai multi-provider endpoint. DeepSeek is deliberately excluded from
// the global edition to eliminate geopolitical/compliance risk and preserve GCG purity.
async function api(prompt,sys,max=6000,signal,model,provider="anthropic",tier){
  const studentCode = typeof window !== "undefined" ? window.__SDE_STUDENT_CODE : null;
  const body = {
    provider,
    model: model || undefined,
    tier: tier || undefined,
    student_code: studentCode || undefined,
    max_tokens:max,
    messages:[{role:"system",content:sys},{role:"user",content:prompt}]
  };
  try{
    const r=await fetch(API_ENDPOINT_MULTI,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      signal,
      body:JSON.stringify(body)
    });
    if(!r.ok){
      const errText=await r.text().catch(()=>"");
      let parsedErr = null;
      try { parsedErr = JSON.parse(errText); } catch {}
      const msg = parsedErr?.error?.message || errText.slice(0, 300);
      // Dispatch student-related events so UI can respond
      if (typeof window !== "undefined") {
        if (r.status === 402) {
          // Budget hard limit reached
          window.dispatchEvent(new CustomEvent("sde-student-blocked", { detail: { message: msg } }));
        } else if (r.status === 401 && msg.includes("student_code required")) {
          window.dispatchEvent(new CustomEvent("sde-student-required"));
        } else if (r.status === 403 && msg.includes("Invalid invite code")) {
          window.dispatchEvent(new CustomEvent("sde-student-invalid"));
        }
      }
      throw new Error("API "+r.status+(msg?": "+msg:""));
    }
    const d=await r.json();
    if(d.error)throw new Error(d.error.message||JSON.stringify(d.error));
    // Expose student status to UI (StudentBadge listens for this)
    if (d.student_status && typeof window !== "undefined") {
      window.__SDE_STUDENT_STATUS = d.student_status;
      window.dispatchEvent(new CustomEvent("sde-student-status-update", { detail: d.student_status }));
    }
    return d.choices?.[0]?.message?.content||"";
  }catch(e){
    if(e.name==="AbortError")throw e;
    return"[Error: "+e.message+"]";
  }
}

// Helper: mark the current paper as completed (called after W7 pipeline success)
async function markPaperDone() {
  const code = typeof window !== "undefined" ? window.__SDE_STUDENT_CODE : null;
  if (!code) return null;
  try {
    const r = await fetch(`/api/student/${encodeURIComponent(code)}/paper-done`, { method: "POST" });
    if (!r.ok) return null;
    const d = await r.json();
    // Trigger StudentBadge refresh
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("sde-paper-done", { detail: d }));
    }
    return d;
  } catch (e) { return null; }
}

// Safely extract JSON from model output that may include markdown fences
function parseJSONSafe(text, fallback = null) {
  if (!text || typeof text !== "string") return fallback;
  try {
    // Remove markdown fences
    let c = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    // Find first { or [ and last matching bracket
    const firstObj = c.indexOf("{"), firstArr = c.indexOf("[");
    const lastObj = c.lastIndexOf("}"), lastArr = c.lastIndexOf("]");
    let start, end;
    if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
      start = firstObj; end = lastObj;
    } else if (firstArr >= 0) {
      start = firstArr; end = lastArr;
    } else {
      return fallback;
    }
    if (start < 0 || end <= start) return fallback;
    return JSON.parse(c.substring(start, end + 1));
  } catch (e) {
    console.warn("parseJSONSafe failed:", e.message);
    return fallback;
  }
}

function Cp({text,label="Copy"}){const[ok,setOk]=useState(false);return <button onClick={()=>{navigator.clipboard?.writeText(text).catch(()=>{});setOk(true);setTimeout(()=>setOk(false),1500);}} style={{padding:"2px 8px",fontSize:9,borderRadius:3,border:"1px solid #8b5cf630",background:ok?"#10b98110":"#8b5cf608",color:ok?"#10b981":"#8b5cf6",cursor:"pointer",fontFamily:"monospace"}}>{ok?"✓":label}</button>;}

// ═══════════════════════════════════════════════════════════════════════
// StudentBadge — cost tracking UI for crowdfunded beta cohort
// Reads/writes window.__SDE_STUDENT_CODE so api() can inject into requests
// ═══════════════════════════════════════════════════════════════════════
function StudentBadge({lang}){
  const[code,setCode]=useState(()=>typeof window!=="undefined"?(localStorage.getItem("sde_student_code")||""):"");
  const[status,setStatus]=useState(null);
  const[inputCode,setInputCode]=useState("");
  const[expanded,setExpanded]=useState(false);
  const[error,setError]=useState("");

  const fetchStatus=useCallback(async(c)=>{
    if(!c)return;
    try{
      const r=await fetch(`/api/student/${encodeURIComponent(c)}`);
      if(!r.ok){
        setError(lang==="zh"?"邀请码无效":"Invalid code");
        return;
      }
      const d=await r.json();
      setStatus(d);
      setError("");
    }catch(e){setError(lang==="zh"?"查询失败":"Query failed");}
  },[lang]);

  useEffect(()=>{
    if(code){
      window.__SDE_STUDENT_CODE=code;
      fetchStatus(code);
    }
  },[code,fetchStatus]);

  useEffect(()=>{
    const handler=(e)=>{
      setStatus(prev=>prev?{...prev,spent_usd:e.detail.spent_usd,remaining_usd:e.detail.remaining_usd,warning:e.detail.warning}:prev);
    };
    const blockedHandler=()=>{
      if(code)fetchStatus(code);  // refresh on block to show red state
    };
    const paperDoneHandler=()=>{
      if(code)fetchStatus(code);  // refresh on paper completion
    };
    const invalidHandler=()=>{
      setError(lang==="zh"?"邀请码已失效":"Code invalid");
      logout();
    };
    window.addEventListener("sde-student-status-update",handler);
    window.addEventListener("sde-student-blocked",blockedHandler);
    window.addEventListener("sde-paper-done",paperDoneHandler);
    window.addEventListener("sde-student-invalid",invalidHandler);
    return()=>{
      window.removeEventListener("sde-student-status-update",handler);
      window.removeEventListener("sde-student-blocked",blockedHandler);
      window.removeEventListener("sde-paper-done",paperDoneHandler);
      window.removeEventListener("sde-student-invalid",invalidHandler);
    };
  },[code,fetchStatus,lang]);

  function enter(){
    const c=inputCode.trim();
    if(!c)return;
    localStorage.setItem("sde_student_code",c);
    window.__SDE_STUDENT_CODE=c;
    setCode(c);
    setInputCode("");
    fetchStatus(c);
  }

  function logout(){
    localStorage.removeItem("sde_student_code");
    window.__SDE_STUDENT_CODE=null;
    setCode("");
    setStatus(null);
    setExpanded(false);
  }

  // Not logged in → hidden by default (single-user beta mode)
  // Activate via: localStorage.setItem("sde_show_login", "1") then reload
  if(!code){
    const showLogin = typeof window !== "undefined" && localStorage.getItem("sde_show_login") === "1";
    if (!showLogin) return null;
    return <div style={{display:"flex",gap:4,alignItems:"center"}}>
      <input value={inputCode} onChange={e=>setInputCode(e.target.value)} placeholder={lang==="zh"?"邀请码":"Invite code"} style={{padding:"3px 8px",fontSize:11,borderRadius:4,border:"1px solid rgba(139,92,246,.2)",width:100,outline:"none"}} onKeyDown={e=>{if(e.key==="Enter")enter();}}/>
      <button onClick={enter} disabled={!inputCode.trim()} style={{padding:"3px 8px",fontSize:10,fontWeight:700,borderRadius:4,border:"none",background:inputCode.trim()?"linear-gradient(135deg,#8b5cf6,#06b6d4)":"rgba(0,0,0,.1)",color:inputCode.trim()?"#fff":"rgba(0,0,0,.3)",cursor:inputCode.trim()?"pointer":"default"}}>{lang==="zh"?"进入":"Enter"}</button>
      {error&&<span style={{fontSize:9,color:"#ef4444"}}>{error}</span>}
    </div>;
  }

  if(!status)return <span style={{fontSize:10,color:"rgba(0,0,0,.4)"}}>···</span>;

  const pct=Math.min(100,(status.spent_usd/status.hard_limit_usd)*100);
  const barColor=status.blocked?"#ef4444":status.warning?"#f59e0b":"#10b981";
  const papersPct=status.papers_target?Math.min(100,(status.papers_completed/status.papers_target)*100):0;

  return <div style={{position:"relative"}}>
    <div onClick={()=>setExpanded(!expanded)} style={{display:"flex",gap:6,alignItems:"center",padding:"3px 8px",borderRadius:6,background:"rgba(139,92,246,.05)",border:"1px solid rgba(139,92,246,.15)",cursor:"pointer",transition:"background .15s"}} onMouseEnter={e=>e.currentTarget.style.background="rgba(139,92,246,.1)"} onMouseLeave={e=>e.currentTarget.style.background="rgba(139,92,246,.05)"}>
      <span style={{fontSize:10,fontWeight:700,color:"#8b5cf6",maxWidth:80,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{status.name||status.code}</span>
      <div style={{width:50,height:5,borderRadius:3,background:"rgba(0,0,0,.08)",overflow:"hidden"}}>
        <div style={{width:`${pct}%`,height:"100%",background:barColor,transition:"width .3s"}}/>
      </div>
      <span style={{fontSize:9,fontWeight:700,color:barColor,fontFamily:"monospace",minWidth:36,textAlign:"right"}}>${status.remaining_usd.toFixed(2)}</span>
    </div>
    {expanded&&<div style={{position:"absolute",top:"calc(100% + 6px)",right:0,zIndex:500,background:"#fff",border:"1px solid rgba(0,0,0,.1)",borderRadius:10,boxShadow:"0 8px 24px rgba(0,0,0,.12)",padding:14,width:300,fontSize:11}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div><div style={{fontSize:12,fontWeight:700,color:"#111"}}>{status.name||status.code}</div><div style={{fontSize:9,color:"rgba(0,0,0,.4)",fontFamily:"monospace"}}>{status.code}</div></div>
        <button onClick={()=>setExpanded(false)} style={{padding:"2px 6px",fontSize:14,border:"none",background:"transparent",cursor:"pointer",color:"rgba(0,0,0,.4)"}}>×</button>
      </div>
      <div style={{marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
          <span style={{color:"rgba(0,0,0,.6)",fontSize:10}}>{lang==="zh"?"API 额度":"Budget"}</span>
          <span style={{fontWeight:600,color:"#111",fontFamily:"monospace",fontSize:10}}>${status.spent_usd.toFixed(3)} / ${status.hard_limit_usd.toFixed(2)}</span>
        </div>
        <div style={{height:6,borderRadius:3,background:"rgba(0,0,0,.06)",overflow:"hidden"}}>
          <div style={{width:`${pct}%`,height:"100%",background:barColor,transition:"width .3s"}}/>
        </div>
        {status.blocked&&<div style={{fontSize:9,color:"#ef4444",marginTop:4,fontWeight:600}}>{lang==="zh"?"⚠ 已达上限，请联系管理员":"⚠ Hard limit reached"}</div>}
        {status.warning&&!status.blocked&&<div style={{fontSize:9,color:"#f59e0b",marginTop:4,fontWeight:600}}>{lang==="zh"?"⚠ 接近额度上限":"⚠ Approaching limit"}</div>}
      </div>
      <div style={{marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
          <span style={{color:"rgba(0,0,0,.6)",fontSize:10}}>{lang==="zh"?"论文进度":"Papers"}</span>
          <span style={{fontWeight:600,color:"#111",fontFamily:"monospace",fontSize:10}}>{status.papers_completed} / {status.papers_target}</span>
        </div>
        <div style={{height:6,borderRadius:3,background:"rgba(0,0,0,.06)",overflow:"hidden"}}>
          <div style={{width:`${papersPct}%`,height:"100%",background:"linear-gradient(90deg,#8b5cf6,#06b6d4)"}}/>
        </div>
      </div>
      <div style={{marginBottom:10,padding:"6px 8px",background:"rgba(0,0,0,.02)",borderRadius:5,fontSize:9,lineHeight:1.6,fontFamily:"monospace"}}>
        <div>🔵 Claude: <b>${(status.by_provider?.anthropic||0).toFixed(3)}</b></div>
        <div>🟢 GPT: <b>${(status.by_provider?.openai||0).toFixed(3)}</b></div>
        <div>🟡 Gemini: <b>${(status.by_provider?.gemini||0).toFixed(3)}</b></div>
      </div>
      <div style={{fontSize:9,color:"rgba(0,0,0,.4)",marginBottom:10}}>
        {lang==="zh"?"调用":"Calls"}: {status.api_calls} · {status.last_call_at?new Date(status.last_call_at).toLocaleString(lang==="zh"?"zh-CN":"en",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}):"—"}
      </div>
      <div style={{display:"flex",gap:6}}>
        <button onClick={()=>fetchStatus(code)} style={{flex:1,padding:"5px 8px",fontSize:10,fontWeight:600,borderRadius:5,border:"1px solid rgba(139,92,246,.2)",background:"rgba(139,92,246,.06)",color:"#8b5cf6",cursor:"pointer"}}>{lang==="zh"?"刷新":"Refresh"}</button>
        <button onClick={logout} style={{flex:1,padding:"5px 8px",fontSize:10,fontWeight:600,borderRadius:5,border:"1px solid rgba(0,0,0,.1)",background:"rgba(0,0,0,.02)",color:"rgba(0,0,0,.6)",cursor:"pointer"}}>{lang==="zh"?"切换":"Switch"}</button>
      </div>
    </div>}
  </div>;
}

function dl(content,name,type="text/plain"){
  if(!content){console.warn("dl: empty content");return;}
  // Add BOM for Word files to ensure UTF-8 encoding
  const bom = type.includes("msword") ? "\uFEFF" : "";
  const fullContent = bom + content;

  // Method 1: Blob + anchor click (best for large files)
  try{
    const blob = new Blob([fullContent],{type:type+";charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{try{document.body.removeChild(a);URL.revokeObjectURL(url);}catch{}},1000);
    return;
  }catch(e1){console.warn("dl method1 failed:",e1);}

  // Method 2: Data URI (fallback for sandboxed environments)
  try{
    const encoded = encodeURIComponent(fullContent);
    const uri = "data:"+type+";charset=utf-8,"+encoded;
    const a = document.createElement("a");
    a.href = uri; a.download = name; a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{try{document.body.removeChild(a);}catch{}},500);
    return;
  }catch(e2){console.warn("dl method2 failed:",e2);}

  // Method 3: Open in new tab (user can Save As)
  try{
    const blob = new Blob([fullContent],{type:type+";charset=utf-8"});
    const url = URL.createObjectURL(blob);
    window.open(url,"_blank");
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    return;
  }catch(e3){console.warn("dl method3 failed:",e3);}

  // Method 4: Copy to clipboard as last resort
  try{
    if(navigator.clipboard){navigator.clipboard.writeText(content);alert(name+" → copied to clipboard (download blocked in this environment)");}
  }catch{}
}

function parsePaperText(text,titleInput=""){
  if(!text||!text.trim())return{title:titleInput||"Untitled",abs:"",kw:[],secs:[{num:1,title:"Content",content:"(empty)"}],refs:[]};
  // Clean HTML if pasted from Word or generated HTML
  text=cleanFileText(text);
  const lines=text.split("\n");let title=titleInput,abs="",kw=[],secs=[],refs=[];
  let curSec=null,curContent=[];let inRefs=false;let inAbs=false;let absContent=[];
  for(const line of lines){
    const t=line.trim();
    if(!title&&t.startsWith("# ")&&!t.startsWith("## ")){title=t.replace(/^#\s*/,"");continue;}
    // ## markdown headings
    if(t.match(/^##\s+/)){
      if(curSec){secs.push({num:secs.length+1,title:curSec,content:curContent.join("\n").trim()});}
      if(inAbs&&absContent.length>0){abs=absContent.join("\n").trim();}
      curSec=null;curContent=[];inRefs=false;inAbs=false;
      const heading=t.replace(/^##\s+\d*\.?\s*/,"").trim();
      const hl=heading.toLowerCase();
      if(hl.includes("reference")||hl.includes("bibliograph")||hl.includes("参考文献")){inRefs=true;}
      else if(hl.includes("abstract")||hl.includes("摘要")){inAbs=true;absContent=[];}
      else if(hl.includes("acknowledgm")||hl.includes("致谢")){}
      else{curSec=heading;}
      continue;
    }
    // Numbered headings: "1. Introduction", "2) Method", "1 引言" (case-insensitive)
    if(t.match(/^\d+[\.\)]\s+\S/)&&t.length<100&&!inRefs){
      if(curSec){secs.push({num:secs.length+1,title:curSec,content:curContent.join("\n").trim()});}
      if(inAbs&&absContent.length>0){abs=absContent.join("\n").trim();}
      const heading=t.replace(/^\d+[\.\)]\s+/,"").trim();
      const hl=heading.toLowerCase();
      inRefs=false;inAbs=false;
      if(hl.includes("reference")||hl.includes("参考文献")){inRefs=true;curSec=null;}
      else if(hl.includes("abstract")||hl.includes("摘要")){inAbs=true;absContent=[];curSec=null;}
      else if(hl.includes("acknowledgm")||hl.includes("致谢")){curSec=null;}
      else{curSec=heading;curContent=[];}
      continue;
    }
    // All-caps headings: "INTRODUCTION", "METHODOLOGY"
    if(!curSec&&!inRefs&&t.match(/^[A-Z][A-Z\s]{3,}$/)&&t.length<60){
      if(curSec){secs.push({num:secs.length+1,title:curSec,content:curContent.join("\n").trim()});}
      if(inAbs&&absContent.length>0){abs=absContent.join("\n").trim();}
      const heading=t.charAt(0)+t.slice(1).toLowerCase();
      inRefs=false;inAbs=false;
      if(heading.toLowerCase().includes("reference")){inRefs=true;curSec=null;}
      else{curSec=heading;curContent=[];}
      continue;
    }
    if(inRefs&&t.length>5){refs.push(t);continue;}
    if(inAbs){absContent.push(line);continue;}
    if(t.toLowerCase().startsWith("**keywords")||t.toLowerCase().startsWith("keywords")||t.startsWith("关键词")){
      const kwStr=t.replace(/^\*?\*?keywords\*?\*?:?\s*/i,"").replace(/^关键词[：:]\s*/,"");kw=kwStr.split(/[;,；，]/).map(k=>k.trim()).filter(Boolean);
      continue;
    }
    if(curSec){curContent.push(line);continue;}
    // Pre-section text → abstract (only if no sections yet)
    if(secs.length===0&&!inRefs&&t.length>20){abs+=(abs?"\n":"")+t;}
  }
  if(curSec)secs.push({num:secs.length+1,title:curSec,content:curContent.join("\n").trim()});
  if(inAbs&&absContent.length>0)abs=absContent.join("\n").trim();
  // Fallback: if no sections found, split text into sections (DON'T use text already in abs)
  if(secs.length===0){
    // Use original text minus whatever was captured as abstract
    const bodyText=abs?text.replace(abs,"").trim():text;
    const fallbackText=bodyText.length>50?bodyText:text;
    const chunks=fallbackText.split(/\n\s*\n/).filter(c=>c.trim().length>30);
    if(chunks.length>=2){
      chunks.forEach((c,i)=>secs.push({num:i+1,title:"Section "+(i+1),content:c.trim()}));
    }else{
      const words=fallbackText.split(/\s+/).filter(w=>w.length>0);
      if(words.length>0){
        const chunkSize=Math.max(200,Math.min(500,Math.ceil(words.length/3)));
        for(let i=0;i<words.length;i+=chunkSize){
          secs.push({num:secs.length+1,title:"Part "+(secs.length+1),content:words.slice(i,i+chunkSize).join(" ")});
        }
      }else{
        secs.push({num:1,title:"Content",content:text.trim()});
      }
    }
    // If abstract was captured and equals the sections content, clear it to avoid duplication
    if(abs&&secs.length>0){
      const absNorm=abs.trim().toLowerCase().substring(0,100);
      const secNorm=secs[0].content.trim().toLowerCase().substring(0,100);
      if(absNorm===secNorm)abs="";
    }
  }
  if(!title)title=titleInput||"Untitled Paper";
  // Remove empty sections
  secs=secs.filter(s=>s.content&&s.content.trim().length>5);
  if(secs.length===0)secs.push({num:1,title:"Content",content:text.trim().substring(0,5000)});
  secs.forEach((s,i)=>{s.num=i+1;});
  return{title,abs,kw,secs,refs};
}

// ═══ Deep Clean: Full deduplication engine ═══
function normSent(s){return s.trim().replace(/\s+/g," ").toLowerCase().replace(/[^\w\u4e00-\u9fff ]/g,"");}
function sentSim(a,b){
  const wa=normSent(a).split(" ").filter(w=>w.length>2);
  const wb=normSent(b).split(" ").filter(w=>w.length>2);
  if(wa.length<3||wb.length<3)return 0;
  const overlap=wa.filter(w=>wb.includes(w)).length;
  return overlap/Math.max(wa.length,wb.length);
}

function deepClean(p){
  if(!p||!p.secs||p.secs.length===0)return{paper:p,log:[]};
  const log=[];
  // 1. Strip leaked headings from section content
  for(const sec of p.secs){
    if(!sec.content)continue;
    const before=sec.content;
    sec.content=sec.content
      .replace(/^#+\s*Abstract[\s\S]*?\n\n/i,"")
      .replace(/^Abstract[:\.\s]*\n+/i,"")
      .replace(/^#+\s*\d*\.?\s*(Introduction|Conclusion|References|Acknowledgm)[^\n]*\n*/i,"")
      .replace(/^Section\s*\d+[:\.\s]*/i,"")
      .trim();
    if(sec.content.length<before.length)log.push(`[${sec.num}. ${sec.title}] stripped leaked heading`);
  }
  
  // 2. Abstract vs all sections: remove duplicate paragraphs
  if(p.abs&&p.abs.trim().length>30){
    const absSents=p.abs.split(/(?<=[.!?。！？])\s+/).filter(s=>s.trim().length>10);
    for(const sec of p.secs){
      const paras=sec.content.split("\n\n");
      const cleaned=[];
      let removed=0;
      for(const para of paras){
        const paraSents=para.split(/(?<=[.!?。！？])\s+/).filter(s=>s.trim().length>10);
        // Check if this paragraph is mostly abstract sentences
        let matchCount=0;
        for(const ps of paraSents){
          for(const as of absSents){
            if(sentSim(ps,as)>0.7){matchCount++;break;}
          }
        }
        const matchRatio=paraSents.length>0?matchCount/paraSents.length:0;
        if(matchRatio>0.5&&paraSents.length>=2){removed++;} 
        else{cleaned.push(para);}
      }
      if(removed>0){
        sec.content=cleaned.join("\n\n").trim();
        log.push(`[${sec.num}. ${sec.title}] removed ${removed} abstract-duplicate paragraph(s)`);
      }
    }
  }

  // 3. Cross-section dedup: find paragraphs repeated between sections
  for(let i=0;i<p.secs.length;i++){
    for(let j=i+1;j<p.secs.length;j++){
      const parasI=p.secs[i].content.split("\n\n").filter(p=>p.trim().length>30);
      const parasJ=p.secs[j].content.split("\n\n").filter(p=>p.trim().length>30);
      const dupIndices=[];
      for(let jj=0;jj<parasJ.length;jj++){
        for(const pi of parasI){
          if(sentSim(parasJ[jj],pi)>0.7){dupIndices.push(jj);break;}
        }
      }
      if(dupIndices.length>0){
        const cleaned=parasJ.filter((_,idx)=>!dupIndices.includes(idx));
        p.secs[j].content=cleaned.join("\n\n").trim();
        log.push(`[${p.secs[j].title}] removed ${dupIndices.length} paragraph(s) duplicated from [${p.secs[i].title}]`);
      }
    }
  }

  // 4. Within-section dedup: repeated paragraphs in same section
  for(const sec of p.secs){
    const paras=sec.content.split("\n\n").filter(p=>p.trim().length>15);
    const seen=[];const unique=[];
    let removed=0;
    for(const para of paras){
      const norm=normSent(para);
      let isDup=false;
      for(const s of seen){if(sentSim(para,s)>0.7){isDup=true;break;}}
      if(isDup){removed++;}else{unique.push(para);seen.push(para);}
    }
    if(removed>0){
      sec.content=unique.join("\n\n").trim();
      log.push(`[${sec.num}. ${sec.title}] removed ${removed} self-duplicate paragraph(s)`);
    }
  }

  // 5. Remove empty sections
  p.secs=p.secs.filter(s=>s.content&&s.content.trim().length>10);
  p.secs.forEach((s,i)=>{s.num=i+1;});

  if(log.length===0)log.push("No duplicates found ✓");
  return{paper:p,log};
}

// Backward compat wrapper
function dedupPaper(p){return deepClean(p).paper;}

function wordHtml(paper){
  if(!paper)return"<html><body><p>No paper data</p></body></html>";
  const title=paper.title||"Untitled";
  const abs=paper.abs||"";
  const kw=paper.kw||[];
  const secs=paper.secs||[];
  const refs=paper.refs||[];
  const sh=secs.map(function(s){
    if(!s||!s.content)return"";
    var bd=s.content.split("\n").map(function(l){
      var t=l.trim();
      if(!t)return"";
      if(t.startsWith("### "))return"<h3>"+t.replace(/^###\s*/,"")+"</h3>";
      if(t.startsWith("## "))return"<h3>"+t.replace(/^##\s*/,"")+"</h3>";
      if(/^\*?\*?(Theorem|Proposition|Lemma|Corollary|Definition|Proof)\s/.test(t))return"<div style=\"margin:8pt 0;padding:8pt 12pt;border-left:3pt solid #8b5cf6;background:#f8f7ff\"><b>"+t.replace(/\*\*/g,"")+"</b></div>";
      if(/^\*\*.*\*\*$/.test(t))return"<p style=\"margin:6pt 0\"><b>"+t.replace(/\*\*/g,"")+"</b></p>";
      // Handle bullet points
      if(/^[-•*]\s/.test(t))return"<p style=\"margin:2pt 0;padding-left:2em\">• "+t.replace(/^[-•*]\s+/,"")+"</p>";
      if(/^\d+[\.\)]\s/.test(t))return"<p style=\"margin:2pt 0;padding-left:2em\">"+t+"</p>";
      return"<p style=\"text-align:justify;text-indent:2em;line-height:1.8;margin:3pt 0\">"+t+"</p>";
    }).join("\n");
    return"<h2>"+(s.num||"")+". "+(s.title||"")+"</h2>\n"+bd;
  }).join("\n");
  var html="<html xmlns:w=\"urn:schemas-microsoft-com:office:word\">"
    +"<head><meta charset=\"utf-8\">"
    +"<style>@page{size:A4;margin:2.54cm}body{font-family:\"Times New Roman\",serif;font-size:12pt;line-height:1.8}h1{font-size:16pt;text-align:center;margin-bottom:4pt}h2{font-size:14pt;margin-top:14pt}h3{font-size:12pt;margin-top:10pt}.ref{padding-left:2em;text-indent:-2em;font-size:10.5pt;margin:2pt 0}</style>"
    +"</head><body>"
    +"<h1>"+title+"</h1>"
    +"<p style=\"text-align:center\"><b>Desheng Wang</b></p>"
    +"<p style=\"text-align:center;font-style:italic\">Demai International Pte. Ltd.</p>"
    +"<hr>";
  if(abs.trim()){
    html+="<h2>Abstract</h2>"
      +"<div style=\"border-left:3pt solid #8b5cf6;padding:10pt 14pt;background:#fafafa\">"+abs+"</div>";
    if(kw.length)html+="<p><b>Keywords:</b> "+kw.join("; ")+"</p>";
    html+="<hr>";
  }
  html+=sh;
  if(refs.length){
    html+="<h2>References</h2>";
    refs.forEach(function(r){html+="<p class=\"ref\">"+r+"</p>";});
  }
  html+="</body></html>";
  return html;
}
function mkMd(p){if(!p)return"# Untitled\n\nNo paper data.";var md="# "+(p.title||"Untitled")+"\n\n**Desheng Wang** | Demai International Pte. Ltd.\n\n---\n\n";if(p.abs&&p.abs.trim())md+="## Abstract\n\n"+p.abs+"\n\n"+(p.kw&&p.kw.length?"**Keywords:** "+p.kw.join("; ")+"\n\n":"")+"---\n\n";(p.secs||[]).forEach(function(s){if(s)md+="## "+(s.num||"")+". "+(s.title||"")+"\n\n"+(s.content||"")+"\n\n";});if(p.refs&&p.refs.length>0){md+="---\n\n## References\n\n";p.refs.forEach(function(r){md+=r+"\n";});}return md;}

const T={en:{
  quick:"⚡ Quick",quickTitle:"One-Click Paper Generator",quickDesc:"Input topic → auto-generate full paper through all modules",
  quickTopic:"Research Topic / Direction",quickTopicPh:"Enter your research topic, question, or direction...",
  quickStart:"⚡ One-Click Generate",quickRunning:"Generating...",
  quickStep1:"📚 Analyzing research landscape...",quickStep2:"🔬 SDE three-dimensional research...",
  quickStep3:"💡 GCG inspiration genesis...",quickStep4:"📄 Generating paper...",
  quickStep5:"🔧 Polishing & unifying...",quickStep6:"⭐ Peer review scoring...",
  quickDone:"✅ Complete! Paper generated, polished & scored.",
  papers:"📚 Papers",research:"🔬 Research",inspire:"💡 Inspiration",paper:"📄 Paper",polish:"🔧 Polish",
  // Papers input
  papersTitle:"Paper Input & Research Summary",papersDesc:"Upload up to 20 papers (PDF/Word/TXT, max 20MB each), AI discovers new research areas",
  uploadFiles:"📎 Upload Files (PDF/Word/TXT)",pasteArea:"Or paste text below (separate papers with ===)",
  papersCount:"papers loaded",startAnalysis:"📚 Analyze All Papers",analyzing:"Analyzing papers...",
  papersLoaded:"files loaded",removePaper:"✕",
  papersLandscape:"Research Landscape",papersGaps:"Gaps & Opportunities",papersNewQ:"New Questions Born",
  papersNewDirs:"Potential New Research Directions",papersToRes:"→ Research",papersToInsp:"→ Inspiration",
  papersWait:"Paper Input & Research Summary",papersFlow:"Input papers → SDE cross-analysis → New questions emerge",
  // Research
  resTitle:"Preliminary Research",resQ:"Research Question",resPh:"Enter a question or topic you want to investigate with SDE methodology...",
  startRes:"🔬 Start Dragon Claw Research",resDimS:"Claw 1·Core Capture — What exists?",resDimD:"Claw 2·Fracture Detection — Where are the cracks?",
  resDimE:"Claw 3·Recombination Seeds — What can be rebuilt?",resSynth:"Claw 4·Forging Direction — Where to strike?",resWait:"Preliminary Research · Dragon Claw Six-Claw Scan",
  resFlow:"S Structure → D Difference → E Entanglement → Synthesis",
  resToInspire:"→ Inspiration",resToPaper:"→ Paper",resDirs:"Research Directions",
  // Inspire
  areaPlaceholder:"Enter research area...",startGCG:"💡 Start GCG",stop:"⏹ Stop",reset:"↻ Reset",
  r1Label:"── R1: Independent scan ──",r2Label:"── R2: Cross-entanglement ──",synthLabel:"── Synthesis ──",
  done:"✅ Complete",stopped:"⏹ Stopped",
  emergTitle:"🌟 Emergent Results",newProblems:"New Problems (ΔE)",newValues:"New Values (E)",newStructures:"New Structures (S)",
  paperDirs:"📄 Paper Directions",genPaper:"→ Generate Paper",dirInnov:"Innovations",dirAbstract:"Abstract Preview",
  // Paper
  paperTitle:"Paper Generation",importedHint:"✓ Imported",domain:"Domain",journal:"Journal",
  titleLabel:"Paper Title",titlePh:"Title (AI refines)",topicLabel:"Theme",topicPh:"Core theme",
  keyArgs:"Arguments",keyArgsPh:"Innovations",sdeLens:"SDE Lens",sdeLensPh:"Optional",
  wordsLabel:"Words",generate:"▶ Generate",viewPaper:"View →",newPaper:"New",copyMd:"MD",dlWord:"Word",cleanBtn:"🧹 Dedup",
  abstract:"Abstract",keywords:"Keywords",refs:"References",
  waitInspire:"Inspiration · GCG",waitFlow:"R1→R2→Synthesis",
  // Polish
  polishTitle:"Paper Polish",noPaper:"Generate a paper first",feedbackLabel:"Feedback",feedbackPh:"Revision suggestions...",
  polInputTitle:"Load Paper for Polish",polUseGen:"Use Generated Paper",polPasteOwn:"Paste Your Own Paper",
  polPastePh:"Paste your full paper text here...\n\nThe system will automatically detect sections (## headings).\nYou can paste papers from any source.",
  polPaperTitle:"Paper Title",polParsed:"sections detected",polLoadPaper:"Load Paper →",
  overallFb:"Your Revision Ideas",sectionFb:"Per-section feedback (optional)",
  reviewerComments:"Reviewer Comments (paste full review)",reviewerPh:"Paste the reviewer/editor comments here, e.g.: Reviewer 1: The proof of Theorem 3 lacks rigor...\nReviewer 2: The literature review misses recent work by...",
  startPolish:"🔧 Polish",
  polishStep1:"Step 1: Feedback",polishStep2:"Step 2: Cross-Review",reviewing:"Reviewing...",
  e1Review:"E1 Review",e2Review:"E2 Review",e3Review:"E3 Review",revising:"Revising...",
  polishDone:"✅ Done",viewPolished:"View →",repolish:"Again",polished:"Polished",
  unifyLabel:"Full-text Unification",cleanPass:"Final Cleanup",cleanPassN:"Pass",
  // Review
  review:"⭐ Review",reviewTitle:"Paper Review & Scoring",reviewDesc:"GCG three-model peer review simulation",
  reviewNoPaper:"No paper to review",reviewStart:"⭐ Start Review",reviewHistory:"Score History",
  rvInputTitle:"Load Paper for Review",rvUseGen:"Use Generated Paper",rvUsePol:"Use Polished Paper",rvPasteOwn:"Paste Paper for Review",rvLoadPaper:"Load Paper →",
  reviewRound:"Round",reviewOverall:"Overall",reviewE1:"E1 Facts & Data",reviewE2:"E2 Logic & Rigor",reviewE3:"E3 Innovation",
  reviewAvg:"Average",reviewVerdict:"Verdict",reviewToPolish:"→ Polish",reviewAgain:"Review Again",
  reviewV1:"Major Revision",reviewV2:"Minor Revision",reviewV3:"Accept with Changes",reviewV4:"Accept",
  // Project
  projLabel:"Project",projNew:"New",projSave:"Save",projLoad:"Load",projDel:"Del",
  projName:"Project Name",projNamePh:"Enter project name...",projSaved:"✓ Saved",projLoaded:"✓ Loaded",
  projEmpty:"No saved projects",projConfirmDel:"Delete this project?",
  autoSaved:"Auto-saved",projLastSaved:"Last saved",projContinue:"Continue",
},zh:{
  quick:"⚡ 一键生成",quickTitle:"一键论文生成器",quickDesc:"输入主题 → 自动完成全流程：研究→灵感→论文→打磨→审稿",
  quickTopic:"研究主题 / 方向",quickTopicPh:"输入你的研究主题、问题或方向...",
  quickStart:"⚡ 一键生成",quickRunning:"生成中...",
  quickStep1:"📚 分析研究全景...",quickStep2:"🔬 SDE三维分析...",
  quickStep3:"💡 GCG灵感涌现...",quickStep4:"📄 生成论文...",
  quickStep5:"🔧 打磨统稿...",quickStep6:"⭐ 审稿评分...",
  quickDone:"✅ 完成！论文已生成、打磨、评分。",
  papers:"📚 文章输入",research:"🔬 前期研究",inspire:"💡 灵感发生",paper:"📄 论文生成",polish:"🔧 论文打磨",
  // Papers input
  papersTitle:"文章输入和研究总结",papersDesc:"上传最多20篇文章（PDF/Word/TXT，每篇最大20MB），AI发现新研究领域",
  uploadFiles:"📎 上传文件（PDF/Word/TXT）",pasteArea:"或在下方粘贴文字（多篇用 === 分隔）",
  papersCount:"篇文章已加载",startAnalysis:"📚 分析全部文章",analyzing:"文章分析中...",
  papersLoaded:"个文件已加载",removePaper:"✕",
  papersLandscape:"研究全景",papersGaps:"缺口与机会",papersNewQ:"新问题诞生",
  papersNewDirs:"新研究方向",papersToRes:"→ 前期研究",papersToInsp:"→ 灵感发生",
  papersWait:"文章输入和研究总结",papersFlow:"输入文章 → SDE交叉分析 → 新问题涌现",
  resTitle:"前期研究",resQ:"研究问题",resPh:"输入你关心的问题或课题，SDE三维分析将系统性地进行前期研究...",
  startRes:"🔬 启动龙爪手研究",resDimS:"第一爪·抓核 — 已有什么？",resDimD:"第二爪·抓裂缝 — 哪里开裂？",
  resDimE:"第三爪·重组种子 — 什么能重建？",resSynth:"第四爪·锻造方向 — 往哪里打？",resWait:"前期研究 · 龙爪手六爪扫描",
  resFlow:"S结构 → D差异 → E纠缠 → 综合研判",
  resToInspire:"→ 灵感发生",resToPaper:"→ 论文生成",resDirs:"研究方向",
  areaPlaceholder:"输入研究方向...",startGCG:"💡 启动GCG",stop:"⏹ 停止",reset:"↻ 重置",
  r1Label:"── R1: 独立扫描 ──",r2Label:"── R2: 交叉纠缠 ──",synthLabel:"── 合成涌现 ──",
  done:"✅ 完成",stopped:"⏹ 已停止",
  emergTitle:"🌟 SDE涌现结果",newProblems:"新问题 (ΔE)",newValues:"新价值 (E)",newStructures:"新结构 (S)",
  paperDirs:"📄 论文方向",genPaper:"→ 生成论文",dirInnov:"创新点",dirAbstract:"摘要预览",
  paperTitle:"论文生成",importedHint:"✓ 已导入",domain:"领域",journal:"期刊",
  titleLabel:"论文题目",titlePh:"标题（AI可优化）",topicLabel:"研究主题",topicPh:"核心方向",
  keyArgs:"关键论点",keyArgsPh:"创新点",sdeLens:"SDE视角",sdeLensPh:"可选",
  wordsLabel:"字数",generate:"▶ 生成论文",viewPaper:"查看 →",newPaper:"新建",copyMd:"MD",dlWord:"Word",cleanBtn:"🧹 去重清理",
  abstract:"摘要",keywords:"关键词",refs:"参考文献",
  waitInspire:"灵感发生 · GCG三模型",waitFlow:"R1扫描→R2纠缠→合成",
  polishTitle:"论文打磨",noPaper:"请先生成论文",feedbackLabel:"修改意见",feedbackPh:"输入修改建议...",
  polInputTitle:"导入论文",polUseGen:"使用已生成论文",polPasteOwn:"粘贴论文原文",
  polPastePh:"在此粘贴完整论文原文...\n\n系统会自动识别章节（## 标题）。\n支持从任何来源粘贴论文。",
  polPaperTitle:"论文标题",polParsed:"个章节已识别",polLoadPaper:"导入论文 →",
  overallFb:"自己的修改意见",sectionFb:"各节修改意见（可选）",
  reviewerComments:"审稿意见（粘贴完整审稿意见）",reviewerPh:"粘贴审稿人/编辑的意见，如：\n审稿人1：定理3的证明不够严谨...\n审稿人2：文献综述缺少近期的...\n编辑：建议补充数值实验...",
  startPolish:"🔧 开始打磨",
  polishStep1:"第一步：反馈",polishStep2:"第二步：交叉审稿",reviewing:"审稿中...",
  e1Review:"E1审查",e2Review:"E2审查",e3Review:"E3审查",revising:"修订中...",
  polishDone:"✅ 完成",viewPolished:"查看 →",repolish:"再打磨",polished:"打磨后",
  unifyLabel:"全文统稿",cleanPass:"最后清理",cleanPassN:"第",
  // Review
  review:"⭐ 审稿评分",reviewTitle:"论文审稿与评分",reviewDesc:"GCG三模型模拟同行评审",
  reviewNoPaper:"请先导入论文",reviewStart:"⭐ 开始审稿",reviewHistory:"评分历史",
  rvInputTitle:"导入论文",rvUseGen:"使用已生成论文",rvUsePol:"使用打磨后论文",rvPasteOwn:"粘贴论文原文",rvLoadPaper:"导入论文 →",
  reviewRound:"第",reviewOverall:"综合",reviewE1:"E1 事实与数据",reviewE2:"E2 逻辑与严谨",reviewE3:"E3 创新性",
  reviewAvg:"平均分",reviewVerdict:"审稿结论",reviewToPolish:"→ 打磨",reviewAgain:"再次审稿",
  reviewV1:"大修",reviewV2:"小修",reviewV3:"修改后接受",reviewV4:"接受",
  // Project
  projLabel:"项目",projNew:"新建",projSave:"保存",projLoad:"加载",projDel:"删除",
  projName:"项目名称",projNamePh:"输入项目名称...",projSaved:"✓ 已保存",projLoaded:"✓ 已加载",
  projEmpty:"暂无保存的项目",projConfirmDel:"确认删除此项目？",
  autoSaved:"已自动保存",projLastSaved:"上次保存",projContinue:"继续",
}};

export default function App(){
  const[tab,setTab]=useState("gate");
  const[lang,setLang]=useState("zh");
  const t=T[lang];const lf=lang==="zh"?"Chinese":"English";

  // Papers Input
  // Each item: {id, name, content, summary?, status: 'loading'|'loaded'|'summarizing'|'summarized'|'error'}
  const[inputPapers,setInputPapers]=useState([]);
  const[paText,setPaText]=useState(""); // for paste
  const[paBusy,setPaBusy]=useState(false);const[paLogs,setPaLogs]=useState([]);
  const[paResult,setPaResult]=useState(null);const[paPhase,setPaPhase]=useState("");
  const paRef=useRef(null);const paAbort=useRef(null);const paFileRef=useRef(null);

  // Research
  const[rQ,setRQ]=useState("");const[rBusy,setRBusy]=useState(false);
  const[rLogs,setRLogs]=useState([]);const[rReport,setRReport]=useState(null);const[rDirs,setRDirs]=useState([]);
  const[rPhase,setRPhase]=useState("");const rRef=useRef(null);const rAbort=useRef(null);

  // Inspire
  const[area,setArea]=useState("");const[iBusy,setIBusy]=useState(false);
  const[msgs,setMsgs]=useState([]);const[synth,setSynth]=useState(null);
  const[iPhase,setIPhase]=useState("");const iRef=useRef(null);const iAbort=useRef(null);

  // Paper
  const[pStep,setPStep]=useState("cfg");const[dom,setDom]=useState(null);const[jrnl,setJrnl]=useState("");const[pTmpl,setPTmpl]=useState(0);
  const[pTitle,setPTitle]=useState("");const[topic,setTopic]=useState("");
  const[lens,setLens]=useState("");const[args,setArgs]=useState("");
  const[wc,setWc]=useState(1200);const[pBusy,setPBusy]=useState(false);
  const[pLogs,setPLogs]=useState([]);const[paper,setPaper]=useState(null);
  const[pProg,setPProg]=useState(0);const pRef=useRef(null);const pAbort=useRef(null);

  // Polish
  const[polStep,setPolStep]=useState("input");const[polFb,setPolFb]=useState("");const[revComments,setRevComments]=useState("");const[secFbs,setSecFbs]=useState({});
  const[polBusy,setPolBusy]=useState(false);const[polLogs,setPolLogs]=useState([]);
  const[polished,setPolished]=useState(null);const polAbortRef=useRef(null);const polRef=useRef(null);
  const[polPaperText,setPolPaperText]=useState("");const[polPaper,setPolPaper]=useState(null);const[polTitleInput,setPolTitleInput]=useState("");
  const[cleanLog,setCleanLog]=useState(null);

  // Review & Scoring
  const[rvStep,setRvStep]=useState("input"); // input | scoring | result
  const[rvPaper,setRvPaper]=useState(null);const[rvPaperText,setRvPaperText]=useState("");const[rvTitleInput,setRvTitleInput]=useState("");
  const[rvBusy,setRvBusy]=useState(false);const[rvLogs,setRvLogs]=useState([]);
  const[rvResult,setRvResult]=useState(null);
  const[rvHistory,setRvHistory]=useState([]);
  const rvRef=useRef(null);const rvAbort=useRef(null);

  // Quick mode
  const[qTopic,setQTopic]=useState("");const[qDom,setQDom]=useState(null);
  const[qBusy,setQBusy]=useState(false);const[qLogs,setQLogs]=useState([]);const[qStep,setQStep]=useState(0); // 0=idle, 1-6=steps
  const[qResult,setQResult]=useState(null);const[qView,setQView]=useState("logs"); // {paper, polished, review}
  const qRef=useRef(null);const qAbort=useRef(null);

  // Project management
  const[projName,setProjName]=useState("");const[projList,setProjList]=useState([]);
  const[gateTarget,setGateTarget]=useState(null);
  const[entryMode,setEntryMode]=useState(null); // "quick" or "collab"
  const[projMsg,setProjMsg]=useState("");const[showProj,setShowProj]=useState(false);
  const[showSaveInput,setShowSaveInput]=useState(false);const[saveName,setSaveName]=useState("");
  const[delConfirm,setDelConfirm]=useState(null);const[lastSaved,setLastSaved]=useState("");
  const projInitRef=useRef(false);
  const saveTimer=useRef(null);
  const isLoading=useRef(false);

  const getProjectData=()=>{try{return{
    tab,entryMode,inputPapers,paResult,
    rQ,rReport,rDirs,
    area,synth,msgs,
    dom,jrnl,pTmpl,pTitle,topic,lens,args,wc,pStep,paper,
    polStep,polPaper,polFb,revComments,secFbs,polished,
    rvResult,rvHistory,rvPaper,rvStep,
    qTopic,qDom,qStep,qResult,qView,qLogs,
    _saved:new Date().toISOString()
  };}catch{return{_saved:new Date().toISOString()};}};
  const projectDataRef=useRef(null);
  projectDataRef.current=getProjectData;

  const saveProject=async(name)=>{
    if(!name||!name.trim())return;
    const key="proj:"+name.trim();
    try{
      const getData=projectDataRef.current;
      if(!getData)return;
      await window.storage.set(key,JSON.stringify(getData()));
      const now=new Date().toLocaleTimeString();
      setProjMsg(t.projSaved+" "+now);setProjName(name.trim());setLastSaved(now);
      try{const r=await window.storage.list("proj:");if(r&&r.keys)setProjList(r.keys);}catch{}
      setTimeout(()=>setProjMsg(""),3000);
    }catch(e){setProjMsg("Error: "+(e.message||"save failed"));}
  };

  const autoSave=useCallback(async()=>{
    if(isLoading.current)return;
    try{
      const getData=projectDataRef.current;
      if(!getData)return;
      const data=JSON.stringify(getData());
      if(projName)try{await window.storage.set("proj:"+projName,data);}catch{}
      try{await window.storage.set("proj:__autosave__",data);}catch{}
      setLastSaved(new Date().toLocaleTimeString());
    }catch{}
  },[projName]);

  const debouncedSave=useCallback(()=>{
    if(isLoading.current)return;
    if(saveTimer.current)clearTimeout(saveTimer.current);
    saveTimer.current=setTimeout(()=>{autoSave();},3000);
  },[autoSave]);

  const loadProject=async(key,skipTab)=>{
    isLoading.current=true;
    try{
      let r;try{r=await window.storage.get(key);}catch{isLoading.current=false;return;}
      if(!r||!r.value){isLoading.current=false;return;}
      let d;try{d=JSON.parse(r.value);}catch{isLoading.current=false;setProjMsg("Parse error");return;}
      if(!d||typeof d!=="object"){isLoading.current=false;return;}
      if(!skipTab&&d.tab)setTab(d.tab);
      if(d.entryMode)setEntryMode(d.entryMode);
      if(Array.isArray(d.inputPapers))setInputPapers(d.inputPapers);if(d.paResult)setPaResult(d.paResult);
      if(d.rQ!=null)setRQ(d.rQ);if(d.rReport)setRReport(d.rReport);if(d.rDirs)setRDirs(d.rDirs);
      if(d.area!=null)setArea(d.area);if(d.synth)setSynth(d.synth);if(Array.isArray(d.msgs))setMsgs(d.msgs);
      if(d.dom!=null)setDom(d.dom);if(d.jrnl!=null)setJrnl(d.jrnl);if(d.pTmpl!=null)setPTmpl(d.pTmpl);
      if(d.pTitle!=null)setPTitle(d.pTitle);if(d.topic!=null)setTopic(d.topic);
      if(d.lens!=null)setLens(d.lens);if(d.args!=null)setArgs(d.args);
      if(d.wc)setWc(d.wc);if(d.pStep)setPStep(d.pStep);if(d.paper)setPaper(d.paper);
      if(d.polStep)setPolStep(d.polStep);if(d.polPaper)setPolPaper(d.polPaper);
      if(d.polFb!=null)setPolFb(d.polFb);if(d.revComments!=null)setRevComments(d.revComments);
      if(d.secFbs)setSecFbs(d.secFbs);if(d.polished)setPolished(d.polished);
      if(d.rvResult)setRvResult(d.rvResult);if(Array.isArray(d.rvHistory))setRvHistory(d.rvHistory);
      if(d.rvPaper)setRvPaper(d.rvPaper);if(d.rvStep)setRvStep(d.rvStep);
      if(d.qTopic!=null)setQTopic(d.qTopic);if(d.qDom!=null)setQDom(d.qDom);
      if(d.qStep)setQStep(d.qStep);
      if(d.qResult)setQResult(d.qResult);if(d.qView)setQView(d.qView);if(Array.isArray(d.qLogs))setQLogs(d.qLogs);
      const name=key.replace("proj:","");
      if(name!=="__autosave__")setProjName(name);
      setLastSaved(d._saved?new Date(d._saved).toLocaleTimeString():"");
      setProjMsg(t.projLoaded);setShowProj(false);
      setTimeout(()=>{setProjMsg("");isLoading.current=false;},500);
    }catch(e){setProjMsg("Error: "+(e&&e.message?e.message:"load failed"));isLoading.current=false;}
  };

  const deleteProject=async(key)=>{
    try{await window.storage.delete(key);
      const r=await window.storage.list("proj:");if(r&&r.keys)setProjList(r.keys);else setProjList([]);
    }catch{}
  };

  const goHome=useCallback(()=>{autoSave();setEntryMode(null);setTab("gate");},[autoSave]);
  const backBtn=(onClick,label)=><button onClick={()=>{autoSave();onClick();}} style={{padding:"2px 8px",fontSize:10,borderRadius:4,border:"1px solid rgba(139,92,246,.2)",background:"rgba(139,92,246,.05)",color:"#8b5cf6",fontWeight:600,cursor:"pointer",fontFamily:"monospace"}} title={lang==="zh"?"保存并返回":"Save & Back"}>{"← "+(label||"")}</button>;

  const newProject=()=>{
    setProjName("");setTab("gate");setEntryMode(null);setLastSaved("");
    setInputPapers([]);setPaText("");setPaLogs([]);setPaResult(null);
    setRQ("");setRLogs([]);setRReport(null);
    setArea("");setMsgs([]);setSynth(null);
    setDom(null);setJrnl("");setPTmpl(0);setPTitle("");setTopic("");setLens("");setArgs("");setWc(1200);setPStep("cfg");setPaper(null);setPLogs([]);
    setPolStep("input");setPolPaper(null);setPolFb("");setRevComments("");setSecFbs({});setPolished(null);setPolLogs([]);setPolTitleInput("");setPolPaperText("");
    setCleanLog(null);
    setRvResult(null);setRvHistory([]);setRvLogs([]);setRvPaper(null);setRvStep("input");setRvPaperText("");setRvTitleInput("");setRvAutoStart(false);
    setQTopic("");setQDom(null);setQBusy(false);setQLogs([]);setQResult(null);setQStep(0);
  };

  // Load project list on mount + auto-load last used project
  useEffect(()=>{if(projInitRef.current)return;projInitRef.current=true;
    (async()=>{
      try{
        const r=await window.storage.list("proj:");
        if(r&&r.keys&&r.keys.length>0){
          setProjList(r.keys);
          let latest=null,latestTime=0;
          for(const key of r.keys){
            if(key==="proj:__autosave__")continue;
            try{const pr=await window.storage.get(key);if(pr&&pr.value){const d=JSON.parse(pr.value);
              const t=d._saved?new Date(d._saved).getTime():0;if(t>latestTime){latestTime=t;latest=key;}}}catch{}}
          if(latest){await loadProject(latest,true);}
          else if(r.keys.includes("proj:__autosave__")){await loadProject("proj:__autosave__",true);}
        }
      }catch{}
    })();
  },[]);

  useEffect(()=>{paRef.current?.scrollTo(0,paRef.current.scrollHeight);},[paLogs,paResult]);
  useEffect(()=>{rRef.current?.scrollTo(0,rRef.current.scrollHeight);},[rLogs,rReport]);
  useEffect(()=>{iRef.current?.scrollTo(0,iRef.current.scrollHeight);},[msgs,synth]);
  useEffect(()=>{pRef.current?.scrollTo(0,pRef.current.scrollHeight);},[pLogs]);
  useEffect(()=>{polRef.current?.scrollTo(0,polRef.current.scrollHeight);},[polLogs]);
  useEffect(()=>{rvRef.current?.scrollTo(0,rvRef.current.scrollHeight);},[rvLogs]);
  // Auto-start review helper
  const rvPaperRef=useRef(null);
  const[rvAutoStart,setRvAutoStart]=useState(false);
  const startReviewWithPaper=(p)=>{
    rvPaperRef.current=p;
    setRvPaper(p);setRvStep("scoring");setRvLogs([]);setRvResult(null);
    setRvAutoStart(true);
  };

  const runReviewDirect=async(rp)=>{
    if(!rp||!rp.secs||rp.secs.length===0)return;
    const ctrl=new AbortController();rvAbort.current=ctrl;const sig=ctrl.signal;
    setRvBusy(true);setRvLogs([]);setRvResult(null);setRvAutoStart(false);
    const pl=(m,c)=>setRvLogs(p=>[...p,{m,c}]);

    // Truncate paper if too long to avoid API limits
    const maxChars=8000;
    const paperSecs=rp.secs.map(s=>`## ${s.num}. ${s.title}\n${s.content.substring(0,Math.floor(maxChars/rp.secs.length))}`).join("\n\n");
    const fullText=`TITLE: ${rp.title}\n\n`+(rp.abs?`ABSTRACT:\n${rp.abs}\n\n`:"")+paperSecs;
    pl(`◉ ${t.reviewTitle} | ${rp.title}`,"#f97316");
    pl(`◉ ${rp.secs.length}${lang==="zh"?"节":"sec"} · ${rp.secs.reduce((s,x)=>s+x.content.split(/\s+/).length,0)}${lang==="zh"?"词":"w"}`,"#06b6d4");

    const scorePrompt=(role,focus)=>`Review this academic paper strictly. Score 0-100.

PAPER:
${fullText}

YOUR FOCUS — ${focus}:
1. Strengths (3-5 specific points)
2. Weaknesses (3-5 specific points)  
3. Improvement suggestions (3-5 concrete actions)
${role==="E2"?`
4. CONSTITUTIONAL CHECK (Innovation Constitution compliance):
   a. Does the paper address a REAL fracture (crack) in the field, not a manufactured problem?
   b. Is the concept core clear enough to state in one sentence (≤20 words)?
   c. Is the argument chain complete — no logical jumps?
   d. TERMINOLOGY PURITY: Does the paper contain ANY traces of meta-framework jargon that doesn't belong in this discipline? (e.g., terms like "genesis chain", "difference-sequence", "entanglement condition", "structure-disclosure", "D-chain", "ΔE", or any other non-standard terms that a domain expert would find foreign) — List any found.
   e. Could a domain expert who knows NOTHING about the source methodology fully understand this paper?`:""}

End with EXACTLY: SCORE: [number]
Typical published paper: 70-85. Below 60: major revision. Above 90: exceptional.
Language: ${lf}.`;

    const results={};
    try{
      const reviewTasks=[
        ["E1","FACTUAL ACCURACY: data completeness, literature coverage, empirical rigor, methodology"+CONST_SYS([1,8,16]),t.reviewE1],
        ["E2","LOGICAL RIGOR & CONSTITUTIONAL COMPLIANCE: argument structure, proof correctness, internal consistency, de-motherization check, 123-triad completeness"+CONST_SYS([6,7,13,16]),t.reviewE2],
        ["E3","INNOVATION & IMPACT: novel contribution, creative insights, cross-domain connections, problem-space generation, holographic depth"+CONST_SYS([2,7,16]),t.reviewE3],
      ];
      pl("[审稿] E1+E2+E3 parallel...","#f97316");
      const resps=await Promise.all(reviewTasks.map(async([rk,focus,label])=>{
        if(sig.aborted)return{rk,label,resp:"[Aborted]"};
        const reviewSys=`You are a strict academic peer reviewer focusing on ${focus}. Be thorough and specific.`;
        const resp=await api(scorePrompt(rk,focus),reviewSys,5000,sig,null,{E1:"gemini",E2:"anthropic",E3:"openai"}[rk]);
        return{rk,label,resp};
      }));
      if(sig.aborted)throw new DOMException("","AbortError");
      for(const{rk,label,resp}of resps){
        if(resp.startsWith("[Error")){pl(`  ✗ ${label}: ${resp}`,"#ef4444");results[rk]={score:0,comments:resp};continue;}
        const scoreMatch=resp.match(/SCORE:\s*(\d+)/);
        const score=scoreMatch?Math.min(100,Math.max(0,parseInt(scoreMatch[1]))):0;
        results[rk]={score,comments:resp.replace(/SCORE:\s*\d+/,"").trim()};
        pl(`  ✓ ${label}: ${score}/100`,score>=80?"#10b981":score>=60?"#f59e0b":"#ef4444");
      }

      const avg=Math.round((results.E1.score+results.E2.score+results.E3.score)/3);
      const verdict=avg>=85?t.reviewV4:avg>=75?t.reviewV3:avg>=60?t.reviewV2:t.reviewV1;

      const result={e1:results.E1,e2:results.E2,e3:results.E3,avg,verdict,title:rp.title,date:new Date().toISOString()};
      setRvResult(result);
      setRvHistory(prev=>[...prev,{round:prev.length+1,date:new Date().toLocaleDateString(),e1:results.E1.score,e2:results.E2.score,e3:results.E3.score,avg,verdict}]);

      pl(`── ${t.reviewOverall} ──`,"#f97316");
      pl(`  E1: ${results.E1.score} | E2: ${results.E2.score} | E3: ${results.E3.score} | ${t.reviewAvg}: ${avg}`,"#f97316");
      pl(`  ${t.reviewVerdict}: ${verdict}`,avg>=75?"#10b981":"#f59e0b");
      setRvStep("result");
    }catch(e){
      if(e.name==="AbortError")pl(t.stopped,"#ef4444");
      else pl("✗ "+e.message,"#ef4444");
    }
    setRvBusy(false);
  };

  // Auto-start review when paper is loaded from input page
  useEffect(()=>{
    if(rvAutoStart&&rvPaper&&!rvBusy){runReviewDirect(rvPaper);}
  },[rvAutoStart]);

  // Auto-save when key results change (papers analyzed, research done, paper generated, polish done)
  useEffect(()=>{if(paResult||rReport||synth||paper||polished||qResult||rvResult)debouncedSave();},[paResult,rReport,synth,paper,polished,qResult,rvResult]);

  const domObj=DOMAINS.find(d=>d.id===dom);
  const safeName=p=>(p?.title||"paper").replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g,"_").substring(0,40);

  // ═══ PAPERS INPUT & ANALYSIS ═══
  // Enhanced: UUID-based matching (fixes same-name collision bug),
  // per-file metadata (sizeMB/pages/chars/level), and dropped-files warning
  // 升级:读文件后自动调用结构化阅读,带缓存(命中零成本)
  const handleFileUpload=async(files)=>{
    const MAX_PAPERS=20;
    const remainSlots=MAX_PAPERS-inputPapers.length;
    const fileArr=Array.from(files);
    const willProcess=fileArr.slice(0,remainSlots);
    const dropped=fileArr.slice(remainSlots);

    // If user dropped more than we can take, warn immediately
    if(dropped.length>0){
      const warnMsg=lang==="zh"
        ?`⚠️ 已达 ${MAX_PAPERS} 篇上限。已跳过 ${dropped.length} 个文件:${dropped.map(f=>f.name).join(", ")}`
        :`⚠️ Reached ${MAX_PAPERS} paper limit. Skipped ${dropped.length} files: ${dropped.map(f=>f.name).join(", ")}`;
      setInputPapers(p=>[...p,{id:"warn_"+Date.now(),name:"⚠️ Upload Limit",content:warnMsg,meta:{level:"warn",chars:0,sizeMB:0}}].slice(0,MAX_PAPERS));
    }

    // Pre-generate job IDs so we can show all placeholders instantly
    const jobs=willProcess.map(file=>({
      file,
      jobId:(crypto.randomUUID?crypto.randomUUID():("id_"+Date.now()+"_"+Math.random().toString(36).slice(2))),
      name:file.name,
      sizeMB:+(file.size/1024/1024).toFixed(2)
    }));

    // Stage 0 · SHOW ALL PLACEHOLDERS INSTANTLY (all names appear at once)
    setInputPapers(p=>[
      ...p,
      ...jobs.map(j=>({
        id:j.jobId,
        name:j.name+" ⏳",
        content:"[Reading file...]",
        meta:{sizeMB:j.sizeMB,pages:null,chars:0,sentChars:0,level:"unknown",reason:null},
        structured:null,
        cacheHit:false
      }))
    ].slice(0,MAX_PAPERS));

    // Stage 1 + 2 · Process files with CONCURRENCY LIMIT (max 5 parallel PDF parses)
    // Stage 2 现在只做缓存查询，不调用 AI 精读（精读延迟到 analyzePapers 点击时）
    const uploadTasks = jobs.map(({file,jobId,name,sizeMB}) => async () => {
      try{
        // Stage 1: Parse file -> text (browser-local, no API cost)
        const {content,meta}=await readFileAsTextMeta(file);

        // Stage 2: Check cache only (NO API call on upload)
        let structured=null;
        let fromCache=false;
        if(content && !content.startsWith("[") && content.trim().length>200){
          try{
            const hash=await hashContent(content);
            structured=await getPaperFromCache(hash);
            fromCache=!!structured;
          }catch(e){/* hash failure non-fatal */}
        }

        setInputPapers(p=>p.map(pp=>pp.id===jobId?{
          ...pp,
          name: meta.level==="over" ? (name+" ⚠️") : (structured ? (name+" 💾") : name),
          content,
          meta,
          structured,
          cacheHit:fromCache
        }:pp));
      }catch(e){
        setInputPapers(p=>p.map(pp=>pp.id===jobId?{
          ...pp,
          name:name+" ❌",
          content:"[Error: "+e.message+"]",
          meta:{sizeMB,pages:null,chars:0,sentChars:0,level:"over",reason:e.message}
        }:pp));
      }
    });
    await runWithConcurrency(uploadTasks, 5, 1);  // 5 parallel, 1 retry

    if(paFileRef.current)paFileRef.current.value="";
  };
  const addPastedText=()=>{
    if(!paText.trim())return;
    const parts=paText.split(/\n===+\n|\n---+\n/).filter(p=>p.trim().length>20);
    const makeMeta=(c)=>{
      const chars=c.length;
      const level=chars>FILE_LIMITS.WARN_CHARS?"over":chars>FILE_LIMITS.SAFE_CHARS?"warn":"safe";
      return {sizeMB:+(chars/1024/1024*2).toFixed(2),pages:null,chars,sentChars:Math.min(chars,FILE_LIMITS.PER_PAPER_SENT),level,reason:null};
    };
    if(parts.length>1){
      const newPapers=parts.slice(0,20-inputPapers.length).map((p,i)=>{
        const c=p.trim();
        return {id:"paste_"+Date.now()+"_"+i,name:`Pasted ${inputPapers.length+i+1}`,content:c,meta:makeMeta(c)};
      });
      setInputPapers(prev=>[...prev,...newPapers].slice(0,20));
    }else{
      const c=paText.trim();
      setInputPapers(prev=>[...prev,{id:"paste_"+Date.now(),name:`Pasted ${prev.length+1}`,content:c,meta:makeMeta(c)}].slice(0,20));
    }
    setPaText("");
  };

  const analyzePapers=useCallback(async()=>{
    if(paBusy)return;
    const valid=inputPapers.filter(p=>{
      if(!p||!p.content)return false;
      const c=p.content.trim();
      if(c.length<20)return false;
      if(c.startsWith("[Loading")||c.startsWith("[Error")||c.startsWith("[Could not")||c.startsWith("[File exceeds"))return false;
      return true;
    });
    if(valid.length===0){
      setPaLogs([{role:"sys",text:"⚠ "+(lang==="zh"
        ?`没有可分析的文章（${inputPapers.length}篇已加载，但全部无效）。\n请确保文章已成功加载（非⏳或❌状态）。\n可尝试：直接粘贴论文文本到下方输入框，然后点击"添加"。`
        :`No valid papers (${inputPapers.length} loaded but all invalid).\nMake sure papers loaded successfully (not ⏳ or ❌).\nTry: paste paper text into the text area below, then click "Add".`)}]);
      return;
    }
    const ctrl=new AbortController();paAbort.current=ctrl;const sig=ctrl.signal;
    setPaBusy(true);setPaLogs([]);setPaResult(null);setPaPhase("...");
    const add=(r,x)=>{setPaLogs(p=>[...p,{role:r,text:x}]);};

    // ═══════════════════════════════════════════════════════════════════
    // Stage 0 · W1 精读（并发 + 重试）— 延迟执行的结构化精读
    // 上传时只做 PDF 解析，精读等到点击"分析全部文章"时并发调用 Gemini Pro
    // 并发上限 5 防止 API rate limit，每请求失败重试 2 次（exponential backoff）
    // ═══════════════════════════════════════════════════════════════════
    const validCopy=valid.map(p=>({...p}));
    const needsReading=validCopy.filter(p=>!p.structured);
    if(needsReading.length>0){
      const t0=Date.now();
      add("sys",`⏳ ${lang==="zh"?"W1 精读阶段 · Gemini 2.5 Pro":"W1 Reading Stage · Gemini 2.5 Pro"} — ${needsReading.length} ${lang==="zh"?"篇（并发 5，自动重试）":"papers (concurrency 5, auto-retry)"}`);
      setPaPhase(lang==="zh"?`精读 ${needsReading.length} 篇论文中`:`Reading ${needsReading.length} papers`);

      const readTasks=needsReading.map((paper,idx)=>async()=>{
        if(sig.aborted)throw new DOMException("","AbortError");
        const cleanName=paper.name.replace(/ [⏳🔍✅💾⚡⚠️❌]$/,"");
        add("sys",`  → [${idx+1}/${needsReading.length}] ${cleanName}`);

        const hash=await hashContent(paper.content);
        let structured=await getPaperFromCache(hash);
        const fromCache=!!structured;

        if(!structured){
          const readerPrompt=`【原文·${paper.content.length} 字】\n\n${paper.content.substring(0,FILE_LIMITS.PER_PAPER_SENT)}\n\n请按系统提示词的规范,对该论文进行结构化精读,输出完整 JSON。`;
          // W1 精读 · E1 事实捕获 — 降回 Flash（Pro 2 万字精读会超时,Flash 5-10 秒稳定返回）
          // 精读本质是结构化信息提取,Flash 的性价比和稳定性都更优
          const rawRes=await api(readerPrompt, PAPER_READER_SYS, 8000, sig, null, "gemini", "economy");
          if(rawRes.startsWith("[Error")){throw new Error(rawRes);}
          structured=parseJSONSafe(rawRes, null);
          if(structured){await savePaperToCache(hash, structured);}
        }

        if(structured){
          paper.structured=structured;
          paper.cacheHit=fromCache;
          setInputPapers(p=>p.map(pp=>pp.id===paper.id?{
            ...pp,
            name:pp.name.replace(/ [⏳🔍✅💾⚡⚠️❌]$/,"")+(fromCache?" 💾":" ✅"),
            structured,
            cacheHit:fromCache
          }:pp));
          add("sys",`  ${fromCache?"💾":"✅"} ${cleanName}`);
        } else {
          throw new Error("JSON parse failed");
        }
        return {paperId:paper.id,success:true};
      });

      const readResults=await runWithConcurrency(readTasks, 5, 2);  // 5 parallel, 2 retries
      if(sig.aborted)throw new DOMException("","AbortError");

      const failed=readResults.filter(r=>!r.ok&&!r.aborted);
      const succeeded=readResults.filter(r=>r.ok);
      const elapsed=Math.round((Date.now()-t0)/1000);
      add("sys",`✅ ${lang==="zh"?"W1 精读完成":"W1 Reading complete"}: ${succeeded.length}/${needsReading.length} ${lang==="zh"?"成功":"ok"} · ${elapsed}s`);
      if(failed.length>0){
        add("sys",`⚠️ ${failed.length} ${lang==="zh"?"篇精读失败，将用原文前 3000 字兜底":"reading failures, falling back to raw text"}`);
      }
    }

    // 升级:优先使用结构化精读结果(3000 字/篇),缓存命中零成本
    // 兜底:未结构化则退回原文前 3000 字
    const structuredCount=validCopy.filter(p=>p.structured).length;
    const cachedCount=validCopy.filter(p=>p.cacheHit).length;
    const digest=validCopy.map((p,i)=>{
      if(p.structured){
        // 用结构化精读结果(~2500-3000 字/篇,高信息密度)
        const s=p.structured;
        const bib=s.bibliographic||{};
        const findings=(s.findings&&s.findings.main_findings_list)||[];
        const concepts=(s.theoretical_framework&&s.theoretical_framework.core_concepts)||[];
        const stats=(s.findings&&s.findings.key_statistics_or_quotes)||[];
        return `[Paper ${i+1}] ${bib.title_zh||bib.title_original||p.name} (${(bib.authors||[]).join(",")} ${bib.year||""})
【来源】${bib.journal_or_venue||""} · ${bib.discipline||""}
【研究问题】${(s.problem_and_motivation&&s.problem_and_motivation.research_question)||"未提取"}
【理论框架】${(s.theoretical_framework&&s.theoretical_framework.primary_theory)||""} | 核心概念:${concepts.map(c=>c.term_zh||c.term_original).filter(Boolean).join("、")}
【研究方法】${(s.methodology&&s.methodology.specific_method)||""} | 样本:${(s.methodology&&s.methodology.sample_or_corpus)||""}
【主要发现】${findings.map((f,j)=>`(${j+1})${f.finding||""}`).join(" ")}
【关键数据】${stats.slice(0,3).join(" | ")}
【中心论点】${(s.argumentation_structure&&s.argumentation_structure.central_thesis)||""}
【理论贡献】${(s.contributions&&s.contributions.theoretical_contribution)||""}
【局限】${(s.limitations_and_gaps&&s.limitations_and_gaps.self_stated_limitations||[]).join("; ")}
【在领域中的位置】${(s.position_in_field&&s.position_in_field.relation_to_prior_work)||""}`;
      } else {
        // 兜底:原文截断(提升到 3000 字,保留更多细节)
        return `[Paper ${i+1}: ${p.name}]\n${(p.content||"").substring(0,3000)}`;
      }
    }).join("\n\n═══════════════════════════════\n\n");
    add("sys",`◉ ${t.papersTitle} | ${valid.length} ${lang==="zh"?"篇可分析":"valid"} | ${structuredCount} ${lang==="zh"?"篇已结构化精读":"structured"} (${cachedCount} ${lang==="zh"?"缓存命中":"cached"}) | ${digest.length} chars`);

    try{
      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.papersLandscape} ──`);setPaPhase(t.papersLandscape);
      const landscape=await api(`You are reading ${valid.length} academic papers. Analyze the RESEARCH LANDSCAPE.\n\nPAPERS:\n${digest}\n\nIn ${lf}, provide:\n1. What is the common research domain/theme across these papers?\n2. What are the main methodologies used?\n3. What are the key findings and contributions of each paper?\n4. How do these papers relate to each other? What is the intellectual lineage?\n5. What is the current state of the art based on these papers?`,ROLES.E1.sys,5000,sig,null,"gemini");
      if(landscape.startsWith("[Error")){add("sys","✗ E1 API failed: "+landscape);throw new Error(landscape);}
      add("E1",landscape);

      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.papersGaps} ──`);setPaPhase(t.papersGaps);
      const gaps=await api(`Based on these ${valid.length} papers:\n\n${digest}\n\nPrevious landscape analysis:\n${landscape.substring(0,1000)}\n\nIn ${lf}, find:\n1. What GAPS exist between these papers? What questions do they leave unanswered?\n2. Where do the papers CONTRADICT each other?\n3. What assumptions do they share that might be wrong?\n4. What methodological LIMITATIONS are common?\n5. What THRESHOLDS block further progress?`,ROLES.E2.sys,5000,sig,null,"anthropic");
      if(gaps.startsWith("[Error")){add("sys","✗ E2 API failed: "+gaps);throw new Error(gaps);}
      add("E2",gaps);

      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.papersNewQ} ──`);setPaPhase(t.papersNewQ);
      const newQ=await api(`Based on ${valid.length} papers and analysis:\n\nLandscape: ${landscape.substring(0,800)}\nGaps: ${gaps.substring(0,800)}\n\nIn ${lf}, using SDE methodology, discover:\n1. What completely NEW QUESTIONS emerge from reading all papers together that no single paper addresses?\n2. What cross-paper ENTANGLEMENTS reveal hidden research opportunities?\n3. How could SDE (Structure-Difference-Entanglement) framework reframe these research problems?\n4. What would a breakthrough paper look like that builds on ALL of these papers?\n5. List 5-8 specific new research questions ranked by novelty and impact.`,ROLES.E3.sys,5000,sig,null,"openai");
      if(newQ.startsWith("[Error")){add("sys","✗ E3 API failed: "+newQ);throw new Error(newQ);}
      add("E3",newQ);

      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.papersNewDirs} ──`);setPaPhase("...");
      const dirRaw=await api(`Based on analysis of ${valid.length} papers:\nLandscape:${landscape.substring(0,500)}\nGaps:${gaps.substring(0,500)}\nNew questions:${newQ.substring(0,500)}\n\nExtract at least 5 specific NEW RESEARCH QUESTIONS that emerge from reading all papers together. Each question should be a concrete, actionable research problem that no single paper addresses.\n\nALL text in ${lf}. Output ONLY JSON:\n[{"question":"The specific new research question (one sentence)","why":"Why this question matters and which gap it addresses (2-3 sentences)","from_papers":"Which input papers inspired this question"},{"question":"...","why":"...","from_papers":"..."}]`,"Output only valid JSON array.",3000,sig,null,"anthropic","economy");
      let questions=[];
      try{let c=dirRaw.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();const s=c.indexOf("["),e=c.lastIndexOf("]");if(s>=0&&e>s)questions=JSON.parse(c.substring(s,e+1));}catch{}
      if(questions.length<3){
        const lines=newQ.split("\n").filter(l=>l.trim().length>15&&(l.includes("?")||l.includes("？")||/^\d/.test(l.trim())));
        questions=lines.slice(0,5).map(l=>({question:l.replace(/^\d+[\.\)]\s*/,"").trim(),why:"See analysis above",from_papers:"All"}));
        if(questions.length<3)questions=[{question:newQ.substring(0,150),why:"Emergent from cross-paper analysis",from_papers:"All"}];
      }
      add("sys","✅ "+t.done);
      setPaResult({landscape,gaps,newQ,questions,paperCount:valid.length});
    }catch(e){
      if(e.name==="AbortError")add("sys",t.stopped);
      else add("sys","✗ "+(e.message||"Unknown error"));
    }
    setPaPhase("");setPaBusy(false);
  },[inputPapers,paBusy,t,lf,lang]);

  const paToResearch=(q)=>{setRQ(typeof q==="string"?q:q.question+(q.why?"\n"+q.why:""));setTab("research");};
  const paToInspire=(q)=>{setArea(typeof q==="string"?q:q.question+(q.why?"\n"+q.why:""));setTab("inspire");};
  // ═══ PRELIMINARY RESEARCH ═══
  const runResearch=useCallback(async()=>{
    if(!rQ.trim()||rBusy)return;
    const ctrl=new AbortController();rAbort.current=ctrl;const sig=ctrl.signal;
    setRBusy(true);setRLogs([]);setRReport(null);
    const out=[];const add=(role,text)=>{out.push({role,text});setRLogs([...out]);};

    add("sys",`◉ 龙爪手前期研究 | ${rQ}`);

    try{
      // Claw 1: Core Capture (抓核) — E1 maps the existing landscape
      add("sys",`── ${t.resDimS} ──`);setRPhase("Claw1...");
      const sRes=await api(`Research question: "${rQ}"

You are executing Dragon Claw 1: CORE CAPTURE (抓核).
Your task: map what already exists so we know where to look for cracks. In ${lf}, provide 300-400 words:

1. **Existing Frameworks**: What theoretical frameworks, models, or paradigms currently address this question? Which are dominant?
2. **Key Literature**: Who are the main researchers? What are the 5-8 most important papers/books? Where is the intellectual center of gravity?
3. **Established Structures**: What concepts, definitions, and terminologies are standardized? What is the "shell" (旧壳) of this field?
4. **Methodological Tools**: What research methods and tools are commonly used? Are they sufficient?
5. **Current Consensus**: Where does the field agree? What is considered settled? — These settled areas are where cracks hide beneath apparent stability.

Be specific with names, dates, and publications. Flag anything that seems "too settled" — over-stability is a crack signal.`,ROLES.E1.sys,5000,sig,null,"gemini");
      add("E1",sRes);

      // Claw 2: Fracture Detection (抓裂缝) — E2 scans for cracks using the Four Questions
      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.resDimD} ──`);setRPhase("Claw2...");
      const dRes=await api(`Research question: "${rQ}"

Existing landscape (from Claw 1):
${sRes.substring(0,800)}

You are executing Dragon Claw 2: FRACTURE DETECTION (抓裂缝).
Apply the FOUR QUESTIONS (四追问) to find cracks. In ${lf}, provide 300-400 words:

**Question 1 — Terminology Crack**: Where does the existing language become clumsy, roundabout, or require excessive qualifiers when describing new phenomena? What can't the old words capture?
**Question 2 — Method Crack**: Under what conditions do existing methods fail, need too many patches, or produce unstable results? Where are the boundary conditions multiplying?
**Question 3 — Framework Crack**: Where do core parts of the existing framework squeeze against each other, creating internal debates that never converge? What long-running disputes signal a deeper structural problem?
**Question 4 — Foundation Crack**: Are any of the field's unquestioned cornerstones (basic assumptions, ontological premises) starting to wobble? What is everyone taking for granted that might be wrong?

For each crack found, assess:
- **Depth**: Surface(术语)/Concept(方法)/Framework(结构)/Foundation(本体) — which level?
- **Unnamed phenomena**: What exists but has no name yet?
- **Growth potential**: Could a new concept grow here?

Be ruthless. The deeper the crack, the bigger the potential weapon.`,ROLES.E2.sys,5000,sig,null,"anthropic");
      add("E2",dRes);

      // Claw 3: Recombination Seeds (重组种子) — E3 finds cross-domain isomorphisms
      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.resDimE} ──`);setRPhase("Claw3...");
      const eRes=await api(`Research question: "${rQ}"

Existing landscape (Claw 1): ${sRes.substring(0,500)}
Cracks found (Claw 2): ${dRes.substring(0,500)}

You are executing Dragon Claw 3: RECOMBINATION SEEDS (重组种子).
Your task: find raw material for building NEW structures to fill the cracks. In ${lf}, provide 300-400 words:

1. **Cross-Domain Isomorphisms**: What other fields have solved structurally similar problems? What can be borrowed and adapted? (Name specific theories, methods, or tools from other disciplines)
2. **Hidden Connections**: What concepts from different domains, when brought together, create something none of them could alone? What combinations have never been tried?
3. **Recombination Directions**: Based on the cracks found in Claw 2, propose 2-3 specific ways to REORGANIZE existing knowledge into a new framework. Each proposal should name: what gets combined, what gets split apart, what gets elevated to principle, what gets demoted to special case.
4. **Naming Opportunities**: For each recombination direction, what would the NEW concept be called? (Think about names that work in the target discipline — "rename at birth", not after)
5. **Entanglement Assessment**: For each direction, evaluate the entanglement conditions — historical support? tool support? disciplinary readiness? problem density? Is the soil rich enough for this seed to grow?

Be creative but grounded. Every proposal must connect back to a specific crack from Claw 2.`,ROLES.E3.sys,5000,sig,null,"openai");
      add("E3",eRes);

      // Claw 4: Forging Direction (锻造方向) — Synthesize and decide where to strike
      if(sig.aborted)throw new DOMException("","AbortError");
      add("sys",`── ${t.resSynth} ──`);setRPhase("Claw4...");
      const synthRes=await api(`You are synthesizing a Dragon Claw preliminary research report — deciding WHERE TO STRIKE.

QUESTION: "${rQ}"

CLAW 1 — CORE CAPTURE (what exists): ${sRes.substring(0,600)}
CLAW 2 — FRACTURE DETECTION (where it cracks): ${dRes.substring(0,600)}
CLAW 3 — RECOMBINATION SEEDS (what could be rebuilt): ${eRes.substring(0,600)}

In ${lf}, write a 400-500 word forging-direction synthesis:

1. **Crack Assessment**: Which crack from Claw 2 is the deepest and most promising? Rate its depth (Surface/Concept/Framework/Foundation) and explain why this crack, not others, deserves a weapon.

2. **Best Recombination**: Which recombination direction from Claw 3 best fits this crack? Why does it fill the crack rather than just patch over it?

3. **Big Concept Test**: Does the proposed concept meet the Six Criteria?
   - Can it generate a new problem space?
   - Can it survive across different scenarios?
   - Can it grow into a methodology?
   - Can it rewrite old boundaries?
   - Can it be continuously forged?
   - Can it be renamed into another discipline's language?

4. **Entanglement Soil Check**: Is the entanglement network dense enough? (Historical support, tool conditions, disciplinary readiness, problem density, researcher's experience depth)

5. **123 Diagnostic** (Art.16): For the proposed concept, identify its internal triad {A,B,C}. Check: Is A=F(B,C) well-defined? Is any element missing (→function unsolvable → contradiction)? Does the triad show mutual generation (no first cause)? If the triad is incomplete, the concept will collapse.

6. **Recommended Paper Directions**: 3 specific, ranked research directions. For each:
   - One-sentence concept core (≤20 words)
   - Target crack it fills
   - Target discipline and journal
   - Preliminary renaming strategy (what would it be called?)

This synthesis decides what weapon to forge next.`,SDE_SYS+`\nYou write Dragon Claw research synthesis. Language: ${lf}. Be strategic, specific, and decisive.`,5000,sig,null,"anthropic","premium");

      add("sys","✅ "+t.done);

      // Extract new questions as JSON
      if(sig.aborted)throw new DOMException("","AbortError");
      setRPhase("New Questions...");
      const dirRaw=await api(`Based on SDE research about "${rQ}":\n${synthRes.substring(0,800)}\n\nExtract at least 3 specific NEW RESEARCH QUESTIONS that emerge from this SDE three-dimensional analysis. Each should be a concrete problem worth investigating.\n\nALL text in ${lf}. ONLY JSON:\n[{"question":"Specific new research question","why":"Why this matters and what SDE gap it addresses","sde_dim":"S/D/E - which dimension is central"}]`,
        "Output only valid JSON array.",3000,sig,null,"anthropic","economy");
      let newQuestions=[];
      try{let c=dirRaw.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();
        const s=c.indexOf("["),e=c.lastIndexOf("]");
        if(s>=0&&e>s)newQuestions=JSON.parse(c.substring(s,e+1));
      }catch{}
      if(newQuestions.length<3){
        const lines=synthRes.split("\n").filter(l=>l.trim().length>15&&(l.includes("?")||l.includes("？")||/^\d/.test(l.trim())));
        newQuestions=lines.slice(0,3).map(l=>({question:l.replace(/^\d+[\.\)]\s*/,"").trim(),why:"From Dragon Claw synthesis",sde_dim:"SDE"}));
        if(newQuestions.length<3)newQuestions=[{question:rQ+" (deeper analysis needed)",why:"Requires further Dragon Claw investigation",sde_dim:"SDE"}];
      }

      setRReport({s:sRes,d:dRes,e:eRes,synthesis:synthRes,question:rQ,newQuestions});
    }catch(e){
      if(e.name==="AbortError")add("sys",t.stopped);
      else add("sys","✗ "+e.message);
    }
    setRPhase("");setRBusy(false);
  },[rQ,rBusy,t,lf]);

  const rToInspire=(dirText)=>{setArea(dirText||rQ);setTab("inspire");};
  const rToPaper=()=>{setTopic(rQ);setLens("SDE three-dimensional");setArgs(rReport?.synthesis?.substring(0,300)||"");setTab("paper");setPStep("cfg");};

  // ═══ INSPIRATION (compact) ═══
  const inspire=useCallback(async()=>{
    if(!area.trim()||iBusy)return;const ctrl=new AbortController();iAbort.current=ctrl;const sig=ctrl.signal;
    setIBusy(true);setMsgs([]);setSynth(null);const out=[];const add=(r,x,n)=>{out.push({role:r,text:x,round:n});setMsgs([...out]);};
    add("sys","◉ GCG | "+area,0);add("sys",t.r1Label,0);
    const q1=`"${area}"

ROUND 1 — Dragon Claw Independent Analysis (200-300w, ${lf}):
As YOUR role, analyze this topic through the six-claw lens:
1. CORE CAPTURE: What is the most valuable concept embryo hidden here? What has growth potential?
2. FRACTURE DETECTION: Where does the existing knowledge crack? What can't the old language name? Apply the Four Questions (terminology crack? method crack? framework crack? foundation crack?)
3. RECOMBINATION SEED: What cross-domain isomorphism or new combination could fill these cracks?
4. NAMING: If you were to forge a weapon from this, what would you call it in the target discipline?

Be specific. Name concrete theories, papers, researchers. Every claim must connect to a real crack.`;const r1={};
    try{
      // Round 1: E1/E2/E3 PARALLEL (was sequential — saves ~2 API wait times)
      setIPhase("R1·E1+E2+E3");
      const r1Results = await Promise.all(["E1","E2","E3"].map(async(role)=>{
        if(sig.aborted)return{role,txt:""};
        const txt=await api(q1,ROLES[role].sys,8000,sig,null,{E1:"gemini",E2:"anthropic",E3:"openai"}[role]);
        add(role,txt,1);
        return{role,txt};
      }));
      if(sig.aborted)return;
      r1Results.forEach(r=>{r1[r.role]=r.txt;});
      add("sys",t.r2Label,0);const q2=`"${area}"
[E1 found]:${(r1.E1||"").substring(0,500)}
[E2 found]:${(r1.E2||"").substring(0,500)}
[E3 found]:${(r1.E3||"").substring(0,500)}

ROUND 2 — Dragon Claw Cross-Forging (200-300w, ${lf}):
Now that you see what the other two models found:
1. Which crack from all three analyses is the DEEPEST? Why?
2. What did the other models MISS that you can see from your dimension?
3. Propose ONE NEW concept that none of the three found alone — something that only emerges from combining all three perspectives.
4. If this became a paper, what would the title be? What specific journal? What is the one-sentence concept core (≤20 words)?

Challenge the other models. Disagree where needed. The goal is triangular cancellation — not consensus.`;
      // Round 2: E1/E2/E3 PARALLEL cross-cancellation
      setIPhase("R2·E1+E2+E3");
      await Promise.all(["E1","E2","E3"].map(async(role)=>{
        if(sig.aborted)return;
        const txt=await api(q2,ROLES[role].sys,8000,sig,null,{E1:"gemini",E2:"anthropic",E3:"openai"}[role]);
        add(role,txt,2);
      }));
      if(sig.aborted)return;add("sys",t.synthLabel,0);setIPhase("...");
      const sq=`Synthesize "${area}".\nE1:${(r1.E1||"").substring(0,300)}\nE2:${(r1.E2||"").substring(0,300)}\nE3:${(r1.E3||"").substring(0,300)}\n\nONLY JSON. ALL text in ${lf}.\n{"new_problems":["...","...","..."],"new_values":["...","..."],"new_structures":["...","..."],"directions":[{"title":"Specific paper title","innovations":["innovation point 1","innovation point 2","innovation point 3"],"abstract":"150-word paper abstract describing the core contribution and approach"},{"title":"Second paper title","innovations":["...","..."],"abstract":"150-word abstract..."},{"title":"Third paper title","innovations":["...","..."],"abstract":"150-word abstract..."}]}`;
      const sRaw=await api(sq,"Output only valid JSON.",5000,sig,null,"anthropic","economy");if(sig.aborted)return;
      try{let c=sRaw.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();let d=0,s=-1,e=-1;for(let i=0;i<c.length;i++){if(c[i]==="{"){if(d===0)s=i;d++;}if(c[i]==="}"){d--;if(d===0){e=i;break;}}}
        if(s>=0&&e>s)setSynth(JSON.parse(c.substring(s,e+1)));else throw 0;}catch{setSynth({new_problems:sRaw.split("\n").filter(l=>l.trim().length>10).slice(0,3),new_values:[],new_structures:[],directions:[{title:area,innovations:["Dragon Claw analysis"],abstract:"Based on GCG three-model collaborative forging."}]});}
      add("sys",t.done,0);
    }catch(e){if(e.name==="AbortError")add("sys",t.stopped,0);else add("sys","✗ "+e.message,0);}
    setIPhase("");setIBusy(false);
  },[area,iBusy,t,lf]);

  const toPaper=d=>{setDom(matchDomain(d.journal||""));setJrnl(d.journal||"");setPTitle(d.title||"");setTopic(d.title||"");setLens(d.innovations?d.innovations.join("; "):"");setArgs(d.abstract||d.innovations?.join("; ")||"");setPaper(null);setPStep("cfg");setTab("paper");};

  // ═══ PAPER (compact) ═══
  const genPaper=useCallback(async()=>{
    if(!domObj||(!topic.trim()&&!pTitle.trim())||pBusy)return;const ctrl=new AbortController();pAbort.current=ctrl;const sig=ctrl.signal;
    setPStep("gen");setPBusy(true);setPLogs([]);setPProg(0);setPaper(null);
    const j=jrnl||domObj.journals[0],secs=(domObj.tp&&domObj.tp[pTmpl])?domObj.tp[pTmpl].s:domObj.sections,tot=secs.length+4;let n=0;const wps=Math.max(100,Math.round(wc/secs.length));
    const pl=(m,c)=>setPLogs(p=>[...p,{m,c}]);const SYS=PAPER_SYS+`\nFor ${j}. ${domObj.style} ${lf}. Rigorous.`;
    const ms=pTitle||topic;const pd={title:ms,abs:"",kw:[],secs:[],refs:[]};
    pl("◉ "+ms,"#8b5cf6");pl("◉ "+domObj.label+" → "+j,"#06b6d4");
    try{pl("[1] Abstract...","#f59e0b");
      const ar=await api(`Write ONLY these 3 items for a paper about "${ms}"${topic&&pTitle?` Theme:${topic}`:""}${lens?` Innovations:${lens}`:""}${args?` Args:${args}`:""}

TITLE: ${pTitle?`Refine this: "${pTitle}":`:"Propose a strong academic title."}
ABSTRACT: Write a 150-250 word structured abstract. STOP after the abstract.
KEYWORDS: List 4-6 academic keywords, comma-separated.

Output EXACTLY these 3 items. Do NOT write any section content. Do NOT write Introduction. STOP after KEYWORDS.`,SYS,1500,sig);
      const tm=ar.match(/TITLE:\s*(.+?)(?:\n|ABSTRACT)/s),am=ar.match(/ABSTRACT:\s*([\s\S]+?)(?:KEYWORDS|$)/),km=ar.match(/KEYWORDS:\s*(.+)/);
      if(tm)pd.title=tm[1].trim();if(am)pd.abs=am[1].trim();if(km)pd.kw=km[1].split(",").map(k=>k.trim()).filter(Boolean);
      // Trim abstract if it got too long (model might have over-generated)
      const absSentences=pd.abs.split(/(?<=[.!?])\s+/);
      if(absSentences.length>15)pd.abs=absSentences.slice(0,12).join(" ");
      pl("  ✓ "+pd.abs.split(/\s+/).length+"w","#10b981");n++;setPProg(n/tot);
      let ent="[Abstract was already written separately - do NOT repeat it]";
      for(let i=0;i<secs.length;i++){if(sig.aborted)throw new DOMException("","AbortError");const s=secs[i],num=i+1;pl("["+(num+1)+"] "+s+"...","#06b6d4");
        const ph=i===0?"Establish the research gap clearly. State contributions as a numbered list. End with paper roadmap. Do NOT repeat the abstract.":s==="Conclusion"?"Summarize contributions. Discuss limitations. Propose future work.":i<=secs.length*.4?"Establish theoretical/methodological foundations.":i<=secs.length*.7?"Present core contribution and main results.":"Provide validation, examples, and discussion.";
        let c=await api(`Title:"${pd.title}"\nWrite Section ${num} "${s}" (~${wps} words).\n${ph}\n${args?"Key arguments:"+args:""}${lens?"\nTheoretical lens:"+lens:""}\nPrevious sections context:${ent}\n\nIMPORTANT: Do NOT include an abstract. Do NOT repeat the abstract content. Start directly with the section content.\nNo section title heading. Use ### for subsections. **Theorem N.** for theorems. [N] for citations.`,SYS,2000,sig);
        // Strip any abstract heading/content the model may have prepended
        c=c.replace(/^#+\s*Abstract[\s\S]*?\n\n/i,"").replace(/^Abstract[:\s]*\n/i,"").replace(/^##\s*\d*\.?\s*Introduction/i,"").trim();
        pd.secs.push({num,title:s,content:c});pl("  ✓ ~"+c.split(/\s+/).length+"w","#10b981");
        ent+="\n["+s+"]:"+c.split("\n\n").slice(0,2).join(" ").substring(0,250);if(ent.length>2500){const ls=ent.split("\n");ent=ls.slice(0,1).concat(ls.slice(-4)).join("\n");}n++;setPProg(n/tot);}
      if(sig.aborted)throw new DOMException("","AbortError");pl("["+(secs.length+2)+"] Refs...","#f59e0b");
      const rr=await api(`15-20 refs for "${pd.title}" in ${domObj.label}. [N] Author,"Title," Journal,Year.`,SYS,3000,sig,null,"gemini","economy");
      pd.refs=rr.split("\n").filter(l=>l.trim().match(/^\[?\d/));pl("  ✓ "+pd.refs.length+" refs","#10b981");n++;setPProg(n/tot);
      if(sig.aborted)throw new DOMException("","AbortError");pl("["+tot+"] Title...","#f59e0b");
      const tr=await api(`Based on ACTUAL content:\nAbstract:${pd.abs}\nSections:${pd.secs.map(s=>s.title+":"+s.content.substring(0,100)).join("\n")}\nGenerate best title. ${lf}. ONLY the title.`,"Output only a title.",500,sig,null,"anthropic","economy");
      const nt=tr.trim().replace(/^["']|["']$/g,"").replace(/^Title:\s*/i,"");if(nt.length>10&&nt.length<200&&!nt.includes("[Error")){pl("  ✓ →"+nt,"#10b981");pd.title=nt;}
      setPProg(1);pl("✅ ~"+pd.secs.reduce((s,x)=>s+x.content.split(/\s+/).length,0)+"w","#10b981");
      setPaper(dedupPaper(pd));setCleanLog(null);setTimeout(()=>setPStep("read"),500);
    }catch(e){if(e.name==="AbortError"){pl(t.stopped,"#ef4444");if(pd.secs.length>0)setPaper(dedupPaper(pd));}else pl("✗ "+e.message,"#ef4444");}
    setPBusy(false);
  },[dom,topic,pTitle,jrnl,domObj,lang,wc,lens,args,pBusy,pTmpl,t,lf]);

  // ═══ POLISH (compact) ═══
  const runPolish=useCallback(async()=>{
    if(!polPaper||!polPaper.secs||polPaper.secs.length===0||polBusy)return;
    const ctrl=new AbortController();polAbortRef.current=ctrl;const sig=ctrl.signal;
    setPolStep("review");setPolBusy(true);setPolLogs([]);setPolished(null);
    const pl=(m,c)=>setPolLogs(p=>[...p,{m,c}]);
    const paperAbs=polPaper.abs||"";
    const fullPaperText=`TITLE: ${polPaper.title}\n\n`+(paperAbs?`ABSTRACT:\n${paperAbs}\n\n`:"")+polPaper.secs.map(s=>`## ${s.num}. ${s.title}\n${s.content}`).join("\n\n");
    const ufb=polFb+Object.entries(secFbs).filter(([_,v])=>v.trim()).map(([k,v])=>`\n[Section ${k}]: ${v}`).join("");
    const revText=revComments.trim();
    pl(`◉ ${t.polishTitle} | ${polPaper.title}`,"#8b5cf6");
    pl(`◉ ${polPaper.secs.length} sections | full text loaded`,"#06b6d4");
    if(ufb.trim())pl(`◉ ${t.overallFb}: ${ufb.substring(0,80)}...`,"#06b6d4");
    if(revText)pl(`◉ ${t.reviewerComments}: ${revText.substring(0,80)}...`,"#ef4444");

    // rv lives outside try so partial results can be saved on abort
    const rv={title:polPaper.title,abs:paperAbs,kw:[...(polPaper.kw||[])],secs:[],refs:[...(polPaper.refs||[])]};
    let reviews={};

    try{
      pl("[审稿] E1+E2+E3 parallel...","#8b5cf6");
      const polRevResps=await Promise.all([["E1",t.e1Review],["E2",t.e2Review],["E3",t.e3Review]].map(async([rk,rl])=>{
        if(sig.aborted)return{rk,resp:""};
        const resp=await api(
          `You are reviewing a COMPLETE academic paper. Read the ENTIRE text carefully.\n\n`+
          `FULL PAPER:\n${fullPaperText}\n\n`+
          `USER'S REVISION REQUESTS:\n${ufb||"General improvement requested"}\n\n`+
          (revText?`EXTERNAL REVIEWER/EDITOR COMMENTS (must address ALL of these):\n${revText}\n\n`:"")+
          `From your ${rk} perspective, provide a thorough review in ${lf}:\n`+
          `1. List ALL specific issues found (number each one)\n`+
          `2. For each issue, state which section it's in and what exactly to fix\n`+
          `3. Rate each section (1-10)\n`+
          `4. Overall assessment and priority improvements`,
          ROLES[rk].sys,5000,sig,null,{E1:"gemini",E2:"anthropic",E3:"openai"}[rk]);
        return{rk,resp};
      }));
      if(sig.aborted)throw new DOMException("","AbortError");
      for(const{rk,resp}of polRevResps){reviews[rk]=resp;pl("  ✓ "+rk,"#10b981");}
      if(sig.aborted)throw new DOMException("","AbortError");
      pl("── "+t.revising+" ──","#f59e0b");
      const allReviews=`=== E1 ===\n${reviews.E1||""}\n\n=== E2 ===\n${reviews.E2||""}\n\n=== E3 ===\n${reviews.E3||""}`;

      for(const sec of polPaper.secs){
        if(sig.aborted)throw new DOMException("","AbortError");
        pl(`[修订] ${sec.num}. ${sec.title}...`,"#06b6d4");
        const nc=await api(
          `Revise this section of an academic paper.\n\n`+
          `SECTION ${sec.num}: ${sec.title}\n\n`+
          `FULL ORIGINAL TEXT:\n${sec.content}\n\n`+
          `THREE-MODEL REVIEWS:\n${allReviews}\n\n`+
          `AUTHOR'S REQUESTS:\n${ufb||"none"}\n`+
          (secFbs[sec.num]?`SECTION-SPECIFIC FEEDBACK:\n${secFbs[sec.num]}\n\n`:"\n")+
          (revText?`REVIEWER COMMENTS:\n${revText}\n\n`:"")+
          `INSTRUCTIONS: Revise COMPLETELY. Do NOT shorten. Do NOT prepend abstract. Output ONLY revised text. ${lf}.`,
          PAPER_SYS,6000,sig,null,"anthropic","premium");
        const ncClean=nc.replace(/^#+\s*Abstract[\s\S]*?\n\n/i,"").replace(/^Abstract[:\s]*\n/i,"").trim();
        rv.secs.push({num:sec.num,title:sec.title,content:ncClean});
        pl(`  ✓ ${sec.title} (${sec.content.split(/\s+/).length}w → ${ncClean.split(/\s+/).length}w)`,"#10b981");
      }

      // Revise abstract if exists
      if(paperAbs.trim()){
        if(sig.aborted)throw new DOMException("","AbortError");
        pl("[修订] Abstract...","#06b6d4");
        rv.abs=await api(`Revise abstract:\n\n${paperAbs}\n\nREVIEWS:\n${allReviews}\n\n${revText?`REVIEWER:\n${revText}\n\n`:""}Revised abstract only. ${lf}.`,PAPER_SYS,2000,sig);
        pl("  ✓ Abstract","#10b981");
      }

      // Refine title
      if(sig.aborted)throw new DOMException("","AbortError");
      const nt=await api(`Revised paper:\nAbstract:${rv.abs||""}\nSections:${rv.secs.map(s=>s.title+":"+s.content.substring(0,200)).join("\n")}\nONLY title. ${lf}.`,"Output title only.",500,sig,null,"anthropic","economy");
      const ct=nt.trim().replace(/^["']|["']$/g,"").replace(/^Title:\s*/i,"");
      if(ct.length>10&&ct.length<200&&!ct.includes("[Error"))rv.title=ct;

      // ── Full-text Unification ──
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`── ${t.unifyLabel} ──`,"#f59e0b");
      const fullText=rv.secs.map(s=>`[${s.num}. ${s.title}]\n${s.content}`).join("\n\n");
      const unifyResult=await api(
        `You are doing a FULL-TEXT UNIFICATION of an academic paper.\n\n`+
        `TITLE: ${rv.title}\nABSTRACT: ${rv.abs||""}\n\nFULL TEXT:\n${fullText}\n\n`+
        `INSTRUCTIONS:\n`+
        `1. Check terminology consistency — ensure the same concept uses the same term throughout\n`+
        `2. Check logical flow — ensure smooth transitions between sections\n`+
        `3. Check notation consistency — ensure symbols, variables, abbreviations are consistent\n`+
        `4. Check cross-references — ensure section references, theorem numbers, citation numbers are correct\n`+
        `5. Check argument coherence — ensure the paper tells ONE unified story from intro to conclusion\n`+
        `6. Fix any inconsistencies found\n\n`+
        `Output the COMPLETE revised text of ALL sections, in the same format:\n[1. SectionTitle]\ncontent...\n\n[2. SectionTitle]\ncontent...\n\nLanguage: ${lf}. Output ALL sections in full. Do NOT shorten.`,
        PAPER_SYS,6000,sig);
      // Parse unified sections back
      const uniSecs=unifyResult.split(/\n\[(\d+)\.\s*([^\]]+)\]\n/).filter(Boolean);
      if(uniSecs.length>=3){
        const newSecs=[];
        for(let ui=0;ui<uniSecs.length-1;ui+=3){
          const sNum=parseInt(uniSecs[ui])||newSecs.length+1;
          const sTitle=uniSecs[ui+1]||rv.secs[newSecs.length]?.title||"Section";
          const sContent=(uniSecs[ui+2]||"").trim();
          if(sContent.length>10)newSecs.push({num:sNum,title:sTitle,content:sContent});
        }
        if(newSecs.length>=rv.secs.length*0.5){rv.secs=newSecs;pl("  ✓ "+newSecs.length+" sections unified","#10b981");}
        else{pl("  ✓ kept original (parse issue)","#f59e0b");}
      }else{pl("  ✓ kept original","#f59e0b");}

      // ── 3 Final Cleanup Passes ──
      for(let pass=1;pass<=3;pass++){
        if(sig.aborted)throw new DOMException("","AbortError");
        const passLabel=lang==="zh"?`${t.cleanPass} ${t.cleanPassN}${pass}次`:`${t.cleanPass} ${t.cleanPassN} ${pass}`;
        pl(`── ${passLabel} ──`,"#10b981");
        for(let si=0;si<rv.secs.length;si++){
          if(sig.aborted)throw new DOMException("","AbortError");
          const sec=rv.secs[si];
          const prevSec=si>0?rv.secs[si-1]:null;
          const nextSec=si<rv.secs.length-1?rv.secs[si+1]:null;
          const cleanInstr=pass===1?
            `PASS 1 - Remove ALL redundancy and repetition:\n- Delete any sentence that repeats an idea already stated\n- Delete any paragraph that overlaps with abstract or other sections\n- Remove filler phrases and unnecessary hedging\n- Tighten every sentence`:
          pass===2?
            `PASS 2 - Polish language and academic style:\n- Improve sentence structure and clarity\n- Ensure precise academic vocabulary\n- Strengthen transitions between paragraphs\n- Make arguments more concise and powerful`:
            `PASS 3 - Final quality check:\n- Fix any remaining grammatical issues\n- Ensure consistent formatting\n- Verify logical completeness\n- Final word-level polish`;
          const nc=await api(
            `CLEANUP ${passLabel} for section "${sec.num}. ${sec.title}":\n\n`+
            `CURRENT TEXT:\n${sec.content}\n\n`+
            (prevSec?`PREVIOUS SECTION [${prevSec.title}] ends with: ...${prevSec.content.slice(-200)}\n\n`:"")+
            (nextSec?`NEXT SECTION [${nextSec.title}] starts with: ${nextSec.content.slice(0,200)}...\n\n`:"")+
            `${cleanInstr}\n\n`+
            `Output ONLY the cleaned section text. Keep full length — do NOT shorten substantive content. Language: ${lf}.`,
            PAPER_SYS,6000,sig);
          const ncClean=nc.replace(/^#+\s*Abstract[\s\S]*?\n\n/i,"").replace(/^Abstract[:\s]*\n/i,"").trim();
          if(ncClean.length>sec.content.length*0.3){rv.secs[si]={...sec,content:ncClean};}
        }
        pl(`  ✓ ${passLabel}`,"#10b981");
      }

      pl(t.polishDone,"#10b981");
      // Apply dedup on success
      const cleaned=dedupPaper(rv);
      rv.secs=cleaned.secs;rv.abs=cleaned.abs;rv.title=cleaned.title;
    }catch(e){
      if(e.name==="AbortError")pl(t.stopped+" — "+rv.secs.length+"/"+polPaper.secs.length+(lang==="zh"?" 节已完成":" sections done"),"#ef4444");
      else pl("✗ "+e.message,"#ef4444");
      // Fill in unrevised sections from original
      const revisedNums=new Set(rv.secs.map(s=>s.num));
      for(const sec of polPaper.secs){if(!revisedNums.has(sec.num))rv.secs.push({...sec});}
      rv.secs.sort((a,b)=>a.num-b.num);
      if(!rv.abs)rv.abs=paperAbs;
    }
    // Always output whatever we have
    if(rv.secs.length>0){
      setPolished({paper:rv,reviews});setCleanLog(null);
      pl(`◉ ${rv.secs.length}${lang==="zh"?"节已输出":"sec output"}`,"#10b981");
      setTimeout(()=>setPolStep("result"),500);
    }
    setPolBusy(false);
  },[polPaper,polFb,revComments,secFbs,polBusy,t,lf]);

  // ═══ REVIEW & SCORING ═══
  const getReviewPaper=()=>rvPaper||polished?.paper||paper||polPaper;
  const runReview=()=>{const rp=rvPaper||rvPaperRef.current;if(rp)runReviewDirect(rp);};

  useEffect(()=>{setTimeout(()=>{qRef.current?.scrollTo({top:qRef.current.scrollHeight,behavior:"smooth"});},100);},[qLogs,qResult]);

  // ═══ QUICK MODE: One-Click Pipeline ═══
  // ═══════════════════════════════════════════════════════════════════
  // 新版一键生成流水线 · 精细化中文学术论文生成
  // 目标:国内核心期刊发表级,约 40-50 次调用,R1 用于关键推理节点
  // 阶段零(4) + 阶段一(4) + 阶段二(章节 ×2) + 阶段三(8) + 阶段四(4)
  // ═══════════════════════════════════════════════════════════════════
  const runQuick=useCallback(async()=>{
    if(!qTopic.trim()||qBusy)return;
    const ctrl=new AbortController();qAbort.current=ctrl;const sig=ctrl.signal;
    setQBusy(true);setQLogs([]);setQResult(null);
    const pl=(m,c)=>setQLogs(p=>[...p,{m,c}]);
    const domInfo=DOMAINS.find(d=>d.id===qDom)||DOMAINS[0];
    const j=domInfo.journals[0];
    const isZh=lang==="zh";
    const SYS=isZh?PAPER_SYS_CN:PAPER_SYS+`\nFor ${j}. ${domInfo.style} ${lf}. Rigorous.`;
    const topic=qTopic.trim();
    const t0=Date.now();
    let callCount=0;
    const trackCall=(label)=>{callCount++;};

    try{
      // ═══════════════════════════════════════════════════════════════
      // 【阶段零】锁定主题与研究方向 · 4 次调用
      // ═══════════════════════════════════════════════════════════════
      setQStep(1);pl("── 🔬 "+(isZh?"阶段零 · 研究":"Stage Zero · Research")+" ──","#ef4444");

      // Step 0.1 · 学科定位诊断
      pl(`  [0.1] ${isZh?"学科定位诊断":"Discipline diagnosis"}...`,"#06b6d4");trackCall();
      const diagRes=await api(
        `研究主题:"${topic}"\n学科领域:${domInfo.label}\n\n请诊断并输出 JSON。`,
        DIAGNOSIS_SYS, 2000, sig
      );
      const diag=parseJSONSafe(diagRes, {
        primary_discipline: domInfo.label,
        sub_discipline: "",
        paradigm: "",
        typical_journals: [j],
        tone_suggestion: domInfo.style
      });
      pl(`  ✓ ${diag.primary_discipline||"—"} · ${diag.sub_discipline||""}`,"#10b981");

      // Step 0.2 · 深度研究综述
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [0.2] ${isZh?"深度研究综述":"Deep literature review"}...`,"#06b6d4");trackCall();
      const researchPrompt=isZh
        ?`研究主题:"${topic}"\n学科:${diag.primary_discipline}(子学科:${diag.sub_discipline})\n\n请做深度研究综述,800-1200 字。\n\n重点:\n1. 已有研究(主流观点、代表学者、核心文献,特别是中文文献)\n2. 研究空白(国内学术界尚未充分关注的问题)\n3. 跨域契机(可借鉴的其他领域理论或方法)\n4. 综合判断(哪个研究缺口最值得攻克)\n\n用中文学术语言,不要出现 SDE 术语。`
        :`"${topic}"\nDo a focused three-dimensional research analysis in 800-1200 words:\n1. Existing Knowledge\n2. Research Gaps\n3. Cross-Domain Connections\n4. Synthesis\nLanguage: ${lf}.`;
      const research=await api(researchPrompt, SYS, 6000, sig);
      pl(`  ✓ ${research.length} ${isZh?"字":"chars"}`,"#10b981");

      // Step 0.3 · 候选创新角度生成
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [0.3] ${isZh?"候选创新角度生成":"Candidate angles"}...`,"#06b6d4");trackCall();
      const anglesPrompt=isZh
        ?`研究综述:\n${research.substring(0,2000)}\n\n请生成 3-5 个候选研究角度。每个角度要适合国内核心期刊(倾向"增量创新"而非"颠覆性创新")。\n\n严格输出 JSON 数组:\n[{"angle":"角度描述","innovation_type":"理论创新|方法创新|应用创新|综合创新","difficulty":"low|medium|high","publish_potential":"medium|high","risk":"主要风险"},...]`
        :`Based on research:\n${research.substring(0,2000)}\nGenerate 3-5 candidate angles as JSON array.`;
      // W4 Angles — core workstation, premium tier (decides WHERE to strike)
      const anglesRes=await api(anglesPrompt, SYS, 3000, sig, null, "anthropic", "premium");
      const angles=parseJSONSafe(anglesRes, [{angle: topic, innovation_type: "综合创新"}]);
      pl(`  ✓ ${Array.isArray(angles)?angles.length:0} ${isZh?"个候选角度":"candidates"}`,"#10b981");

      // Step 0.4 · 创新角度收敛
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [0.4] ${isZh?"创新角度收敛":"Angle convergence"}...`,"#06b6d4");trackCall();
      const convergePrompt=isZh
        ?`候选角度:\n${JSON.stringify(angles, null, 2)}\n\n请选出最适合国内核心期刊发表的一个。\n严格输出 JSON:\n{"selected_angle":"最终选定的研究角度","title":"30 字以内的论文标题","core_thesis":"30 字以内核心论断","abstract_draft":"150 字摘要草稿","why_this":"为何选择此角度(50 字)"}`
        :`From candidates:\n${JSON.stringify(angles)}\nOutput JSON: {"selected_angle":"...","title":"...","core_thesis":"...","abstract_draft":"...","why_this":"..."}`;
      // W4 Converge — core workstation, premium tier (final direction decision)
      const convergeRes=await api(convergePrompt, SYS, 2000, sig, null, "anthropic", "premium");
      const direction=parseJSONSafe(convergeRes, {
        selected_angle: topic,
        title: topic,
        core_thesis: topic,
        abstract_draft: "",
        why_this: ""
      });
      pl(`  ✓ ${direction.title}`,"#10b981");

      // ═══════════════════════════════════════════════════════════════
      // 【阶段一】锁定骨架 · 4 次调用
      // ═══════════════════════════════════════════════════════════════
      if(sig.aborted)throw new DOMException("","AbortError");
      setQStep(2);pl("── 💡 "+(isZh?"阶段一 · 骨架锁定":"Stage One · Framework Lock")+" ──","#f59e0b");

      // Step 1.1 · 提纲锁定(R1 深度推理)
      pl(`  [1.1] ${isZh?"提纲锁定 (R1 深度推理)":"Outline lock (R1)"}...`,"#06b6d4");trackCall();
      const outlinePrompt=isZh
        ?`研究主题:${topic}\n选定方向:${direction.selected_angle}\n核心论点:${direction.core_thesis}\n学科:${diag.primary_discipline} (${diag.sub_discipline})\n目标期刊:${(diag.typical_journals||[]).join(", ")}\n\n研究综述:\n${research.substring(0,1500)}\n\n请为这篇论文生成完整的提纲锁定 JSON。务必:\n- 所有文献要真实存在(confidence 字段诚实填写)\n- 至少 8 条中文文献\n- 章节计划含每章 claim 和 must_cite\n- 全文 8000-15000 字,分到 7 章平均每章 1200-2000 字`
        :`Topic: ${topic}\nAngle: ${direction.selected_angle}\nThesis: ${direction.core_thesis}\nResearch summary: ${research.substring(0,1500)}\nGenerate full outline-lock JSON.`;
      // W5 Outline lock — core workstation, premium tier (paper skeleton, cannot be fixed later)
      const outlineRes=await api(outlinePrompt, OUTLINE_SYS, 8000, sig, null, "anthropic", "premium");
      const outline=parseJSONSafe(outlineRes, {
        core_thesis: direction.core_thesis,
        key_terms: [],
        key_authors: [],
        chapter_plan: [],
        final_chapter_count: 7
      });
      pl(`  ✓ ${(outline.chapter_plan||[]).length} ${isZh?"章 | 术语":"ch | terms"} ${(outline.key_terms||[]).length} | ${isZh?"文献":"refs"} ${(outline.key_authors||[]).length}`,"#10b981");

      // Step 1.2 · 文献真实性核验
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [1.2] ${isZh?"文献真实性核验":"Citation verification"}...`,"#06b6d4");trackCall();
      const verifyPrompt=isZh
        ?`核验以下文献:\n${JSON.stringify(outline.key_authors||[], null, 2)}`
        :`Verify these citations:\n${JSON.stringify(outline.key_authors||[])}`;
      const verifyRes=await api(verifyPrompt, CITE_VERIFY_SYS, 4000, sig, null, "gemini", "economy");
      const verifyResult=parseJSONSafe(verifyRes, {verified: outline.key_authors||[], removed: []});
      outline.key_authors=verifyResult.verified||outline.key_authors||[];
      pl(`  ✓ ${outline.key_authors.length} ${isZh?"条文献验证通过":"verified"} (${isZh?"删除":"removed"} ${(verifyResult.removed||[]).length})`,"#10b981");

      // Step 1.3 · 章节间衔接设计
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [1.3] ${isZh?"章节衔接设计":"Inter-chapter transitions"}...`,"#06b6d4");trackCall();
      const transitionPrompt=isZh
        ?`章节提纲:\n${JSON.stringify(outline.chapter_plan||[], null, 2)}\n\n请为相邻章节设计衔接。严格 JSON:\n{"transitions":[{"from":1,"to":2,"bridge":"章 1 结尾如何引出章 2"},...]}`
        :`Chapter plan:\n${JSON.stringify(outline.chapter_plan||[])}\nDesign transitions. JSON: {"transitions":[{"from":1,"to":2,"bridge":"..."}]}`;
      const transRes=await api(transitionPrompt, SYS, 3000, sig);
      const transitions=parseJSONSafe(transRes, {transitions: []});
      pl(`  ✓ ${(transitions.transitions||[]).length} ${isZh?"组衔接":"transitions"}`,"#10b981");

      // Step 1.4 · 提纲二次确认(仅做一致性检查,不重写)
      // 简化处理,skip 这一步节约时间

      // ═══════════════════════════════════════════════════════════════
      // 【阶段二】逐章精细生成 · 每章 2 次 × 7-8 章
      // ═══════════════════════════════════════════════════════════════
      if(sig.aborted)throw new DOMException("","AbortError");
      setQStep(3);pl("── 📄 "+(isZh?"阶段二 · 正文生成":"Stage Two · Content Generation")+" ──","#8b5cf6");

      const chapters=(outline.chapter_plan&&outline.chapter_plan.length>=3)?outline.chapter_plan:
        (domInfo.sections||["Introduction","Literature Review","Theoretical Framework","Methodology","Findings","Discussion","Conclusion"]).map((title,i)=>({num:i+1,title,claim:"",must_cite:[],word_target:1500,connects_from_prev:"",connects_to_next:""}));

      const pd={title:direction.title,abs:"",kw:[],secs:[],refs:[]};

      // 统一术语表字符串(供每章 prompt 使用)
      const termsTable=(outline.key_terms||[]).map(tm=>`- ${tm.zh||tm.term||""} (${tm.en||""}): ${tm.definition||""}`).join("\n");
      const citesTable=(outline.key_authors||[]).map((a,i)=>`[${i+1}] ${a.author_zh||a.author||""} (${a.year||""}). ${a.work_zh||a.work||""}. ${a.journal_or_publisher||""}`).join("\n");

      for(let i=0;i<chapters.length;i++){
        if(sig.aborted)throw new DOMException("","AbortError");
        const ch=chapters[i];
        const num=ch.num||(i+1);
        const sTitle=ch.title;
        pl(`  [${num}/${chapters.length}] ${sTitle}...`,"#06b6d4");

        // 上下文衔接(取前章结尾 + 本章必引 + 下章提纲)
        const prevEnd=i>0?(pd.secs[i-1].content||"").slice(-300):"";
        const nextClaim=i<chapters.length-1?(chapters[i+1].claim||""):"";
        const transBridge=(transitions.transitions||[]).find(t=>t.to===num)?.bridge||"";

        // 章节骨架(Step 2.a)
        trackCall();
        const skelPrompt=isZh
          ?`章节:第 ${num} 章 "${sTitle}"\n本章 claim:${ch.claim||sTitle}\n必引:${(ch.must_cite||[]).join(", ")}\n目标字数:${ch.word_target||1500} 字\n${prevEnd?`前章结尾:${prevEnd}\n`:""}${transBridge?`需要承接:${transBridge}\n`:""}\n\n请生成章节骨架 JSON。`
          :`Chapter ${num}: "${sTitle}"\nClaim: ${ch.claim}\nMust cite: ${(ch.must_cite||[]).join(", ")}\nGenerate skeleton JSON.`;
        // W5 Chapter skeleton — premium tier (per-chapter structural design)
        const skelRes=await api(skelPrompt, CHAPTER_SKELETON_SYS, 2000, sig, null, "anthropic", "premium");
        const skel=parseJSONSafe(skelRes, {paragraphs: []});

        // 章节正文(Step 2.b)
        if(sig.aborted)throw new DOMException("","AbortError");
        trackCall();
        const writePrompt=isZh
          ?`你正在写论文《${direction.title}》的第 ${num} 章 "${sTitle}"。
核心论点(全文):${outline.core_thesis||direction.core_thesis}
本章 claim:${ch.claim||sTitle}
目标字数:${ch.word_target||1500} 字(务必接近目标,不要过短)

【分段提纲】
${JSON.stringify(skel.paragraphs||[], null, 2)}

【全文统一术语(必须使用这些术语)】
${termsTable}

【全文统一文献(只能从这里引用,引用时用 [N] 格式)】
${citesTable}

${prevEnd?`【前一章结尾(承接之用)】\n${prevEnd}\n`:""}
${transBridge?`【衔接提示】${transBridge}\n`:""}
${nextClaim?`【下一章主题(末尾需铺垫)】${nextClaim}\n`:""}

【硬性要求】
- 严格用中文学术书面语
- 不出现 SDE 相关术语
- 不用"首先、其次、再次、最后"套语
- 直接开始正文,不要写"本章将讨论..."
- 所有引用必须从上述文献列表选,格式 [N]
- 术语统一使用上述术语表
- 字数不少于 ${Math.round((ch.word_target||1500)*0.8)} 字
- 段落长度自然参差,不追求整齐

直接输出正文,不要任何元说明。`
          :`Write Chapter ${num} "${sTitle}" of paper "${direction.title}".\nClaim: ${ch.claim}\nUse unified terms and only cite from the given list.\nLength: ~${ch.word_target||1500} words.\nLanguage: ${lf}.`;
        // W5 Writing — premium tier (the actual paper content, quality-decisive)
        let c=await api(writePrompt, SYS, 4000, sig, null, "anthropic", "premium");
        c=c.replace(/^#+\s*(Abstract|摘要)[\s\S]*?\n\n/i,"").replace(/^(Abstract|摘要)[:\s]*\n/i,"").trim();
        pd.secs.push({num,title:sTitle,content:c,claim:ch.claim||""});
      }
      pl(`  ✓ ${pd.secs.length} ${isZh?"章完成,总字数":"sections, total"} ${pd.secs.reduce((s,x)=>s+(x.content||"").length,0)}`,"#10b981");

      // ═══════════════════════════════════════════════════════════════
      // 【阶段三】全局打磨 · 一致性审计 + 针对性修复
      // ═══════════════════════════════════════════════════════════════
      if(sig.aborted)throw new DOMException("","AbortError");
      setQStep(4);pl("── 🔧 "+(isZh?"阶段三 · 全局打磨":"Stage Three · Global Polish")+" ──","#10b981");

      // Step 3.1 · 摘要生成(全文完成后再生成,更贴合实际内容)
      pl(`  [3.1] ${isZh?"摘要生成":"Abstract"}...`,"#06b6d4");trackCall();
      const abstractPrompt=isZh
        ?`根据以下论文内容,生成规范的中文学术摘要。\n\n标题:${direction.title}\n核心论点:${outline.core_thesis||direction.core_thesis}\n\n章节大意:\n${pd.secs.map(s=>`${s.num}. ${s.title}: ${(s.content||"").substring(0,200)}`).join("\n")}\n\n请输出:\nTITLE: <精炼标题>\nABSTRACT: <200-300 字摘要,包含目的/方法/结论/意义>\nKEYWORDS: <4-6 个关键词, 逗号分隔>\n\n严格按此格式,不含其他内容。`
        :`Generate abstract based on paper content.\nTITLE: ...\nABSTRACT: 200-300 words\nKEYWORDS: ...`;
      // W5 Abstract/title/keywords — balanced tier (moderately sensitive)
      const abRes=await api(abstractPrompt, SYS, 1500, sig, null, "anthropic", "balanced");
      const tm=abRes.match(/TITLE[::]?\s*(.+?)(?:\n|ABSTRACT)/s);
      const am=abRes.match(/ABSTRACT[::]?\s*([\s\S]+?)(?:KEYWORDS|$)/i);
      const km=abRes.match(/KEYWORDS[::]?\s*(.+)/i);
      if(tm)pd.title=tm[1].trim();
      if(am)pd.abs=am[1].trim();
      if(km)pd.kw=km[1].split(/[,,、]/).map(k=>k.trim()).filter(Boolean);
      pl(`  ✓ ${isZh?"摘要":"Abstract"} ${pd.abs.length} ${isZh?"字":"chars"}`,"#10b981");

      // Step 3.2 · 参考文献规范化(GB/T 7714)
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [3.2] ${isZh?"参考文献规范化 (GB/T 7714)":"References (GB/T 7714)"}...`,"#06b6d4");trackCall();
      const refsPrompt=isZh
        ?`请把以下文献列表转化为严格的 GB/T 7714 格式。\n\n文献源:\n${citesTable}\n\n输出规范:\n- 期刊:[N] 作者. 标题[J]. 期刊名, 年份, 卷(期): 起止页码.\n- 专著:[N] 作者. 书名[M]. 出版地: 出版社, 年份: 页码.\n- 英文文献保留原文\n- 每行一条,从 [1] 开始编号\n\n只输出规范化后的参考文献列表,不含其他内容。`
        :`Format as GB/T 7714 references. Source:\n${citesTable}\nOutput one per line starting [1].`;
      const refsRes=await api(refsPrompt, SYS, 3000, sig, null, "gemini", "economy");
      pd.refs=refsRes.split("\n").filter(l=>l.trim().match(/^\[?\d/)).map(l=>l.trim());
      pl(`  ✓ ${pd.refs.length} ${isZh?"条参考文献":"references"}`,"#10b981");

      // Save raw paper
      const rawPaper=dedupPaper(pd);
      setPaper(rawPaper);

      // Step 3.3 · 一致性审计(R1 严格审查)
      if(sig.aborted)throw new DOMException("","AbortError");
      pl(`  [3.3] ${isZh?"一致性审计 (R1 严格审查)":"Consistency audit (R1)"}...`,"#06b6d4");trackCall();
      const auditPrompt=isZh
        ?`【提纲】\n核心论点:${outline.core_thesis||""}\n关键术语:${(outline.key_terms||[]).map(t=>t.zh||t.term).join(", ")}\n\n【论文正文】\n${pd.secs.map(s=>`## ${s.num}. ${s.title}\n${(s.content||"").substring(0,1500)}`).join("\n\n")}\n\n请严格审计这篇论文的一致性,输出 JSON。`
        :`Audit paper consistency against outline.\nOutline: ${outline.core_thesis}\n${pd.secs.map(s=>`## ${s.title}\n${(s.content||"").substring(0,1500)}`).join("\n\n")}`;
      // W6 Consistency audit — balanced tier (catches drift across the paper)
      const auditRes=await api(auditPrompt, AUDITOR_SYS, 6000, sig, null, "anthropic", "balanced");
      const audit=parseJSONSafe(auditRes, {overall_score: 70, action_list: []});
      const actionList=audit.action_list||[];
      pl(`  ✓ ${isZh?"审计分":"Score"}: ${audit.overall_score||70} · ${actionList.length} ${isZh?"项修改建议":"actions"}`,audit.overall_score>=75?"#10b981":"#f59e0b");

      // Step 3.4 · 按审计建议针对性修复受影响章节
      if(sig.aborted)throw new DOMException("","AbortError");
      const polRv={...rawPaper,secs:rawPaper.secs.map(s=>({...s}))};
      // 把 action_list 按章节分组
      const actionsByChapter={};
      for(const a of actionList){
        const ch=a.chapter||0;
        if(!actionsByChapter[ch])actionsByChapter[ch]=[];
        actionsByChapter[ch].push(a);
      }
      const chaptersToFix=Object.keys(actionsByChapter).filter(ch=>ch>0&&ch<=polRv.secs.length);
      if(chaptersToFix.length>0){
        pl(`  [3.4] ${isZh?"针对性打磨":"Targeted polish"} ${chaptersToFix.length} ${isZh?"章":"ch"}...`,"#06b6d4");
        for(const chNumStr of chaptersToFix){
          if(sig.aborted)throw new DOMException("","AbortError");
          const chNum=parseInt(chNumStr,10);
          const secIdx=polRv.secs.findIndex(s=>s.num===chNum);
          if(secIdx<0)continue;
          const sec=polRv.secs[secIdx];
          const acts=actionsByChapter[chNumStr];
          trackCall();
          const fixPrompt=isZh
            ?`需要按下列修改建议修订第 ${chNum} 章 "${sec.title}" 的内容。\n\n【修改建议】\n${acts.map((a,i)=>`${i+1}. [${a.priority||"medium"}] ${a.action}${a.location_hint?` (${a.location_hint})`:""}`).join("\n")}\n\n【原章节内容】\n${sec.content}\n\n请按建议修改,保持原有长度和结构。只输出修订后的完整正文,不含任何说明。`
            :`Revise Chapter ${chNum} per suggestions:\n${acts.map(a=>`- ${a.action}`).join("\n")}\n\nOriginal:\n${sec.content}\n\nOutput only revised text.`;
          const fixed=await api(fixPrompt, SYS, 4000, sig);
          const cleaned=fixed.replace(/^#+\s*(Abstract|摘要)[\s\S]*?\n\n/i,"").trim();
          if(cleaned.length>sec.content.length*0.5){
            polRv.secs[secIdx]={...sec,content:cleaned};
          }
        }
        pl(`  ✓ ${chaptersToFix.length} ${isZh?"章已针对性修改":"chapters fixed"}`,"#10b981");
      } else {
        pl(`  ✓ ${isZh?"无需修改":"No fixes needed"}`,"#10b981");
      }

      setPolPaper(rawPaper);setPolished({paper:polRv,reviews:{}});

      // ═══════════════════════════════════════════════════════════════
      // 【阶段四】GCG 三角审稿 · 3 次调用(R1)
      // ═══════════════════════════════════════════════════════════════
      if(sig.aborted)throw new DOMException("","AbortError");
      setQStep(5);pl("── ⭐ "+(isZh?"阶段四 · GCG 三角审稿":"Stage Four · GCG Review")+" ──","#f97316");
      const revText=polRv.secs.map(s=>`## ${s.num}. ${s.title}\n${(s.content||"").substring(0,1500)}`).join("\n\n");
      const fullRevText=`TITLE: ${polRv.title}\nABSTRACT: ${polRv.abs||""}\n\n${revText}`;
      const qScorePromptCN=(focusSys, focusName)=>`【审稿任务】\n\n论文:\n${fullRevText}\n\n请按"${focusName}"维度审稿,严格评分。`;
      const qRevTasks=isZh?[
        ["E1", REVIEW_E1_CN, "事实与材料", "gemini"],
        ["E2", REVIEW_E2_CN, "逻辑与论证", "anthropic"],
        ["E3", REVIEW_E3_CN, "创新与价值", "openai"],
      ]:[
        ["E1", ROLES.E1.sys, "FACTUAL ACCURACY", "gemini"],
        ["E2", ROLES.E2.sys, "LOGICAL RIGOR", "anthropic"],
        ["E3", ROLES.E3.sys, "INNOVATION", "openai"],
      ];
      pl(`  [4.1-4.3] ${isZh?"E1 + E2 + E3 并行审稿 (GCG 真·三角互消)":"E1+E2+E3 parallel (true GCG triangulation)"}...`,"#f97316");
      const qRevResps=await Promise.all(qRevTasks.map(async([rk,sysPrompt,focusName,provider])=>{
        if(sig.aborted)return{rk,resp:""};
        trackCall();
        // Each role natively staffed: E1=Gemini (reality), E2=Claude (reasoning), E3=GPT (entanglement)
        // When provider is "deepseek" or undefined, fall back to R1 model for deep reasoning
        const model = null; // Global edition: all providers use their native default model
        const resp=await api(qScorePromptCN(sysPrompt, focusName), sysPrompt, 4000, sig, model, provider);
        return{rk,resp};
      }));
      if(sig.aborted)throw new DOMException("","AbortError");
      const qRevResults={};
      for(const{rk,resp}of qRevResps){
        const sm=resp.match(/SCORE[::]?\s*(\d+)/);
        qRevResults[rk]={score:sm?Math.min(100,Math.max(0,+sm[1])):70,comments:resp.replace(/SCORE[::]?\s*\d+/,"").trim()};
      }
      const e1s=qRevResults.E1.score,e2s=qRevResults.E2.score,e3s=qRevResults.E3.score;
      const avg=Math.round((e1s+e2s+e3s)/3);
      const verdict=avg>=85?t.reviewV4:avg>=75?t.reviewV3:avg>=60?t.reviewV2:t.reviewV1;
      pl(`  ✓ E1:${e1s} · E2:${e2s} · E3:${e3s} → ${avg} ${verdict}`,avg>=75?"#10b981":"#f59e0b");

      const rvRes={e1:qRevResults.E1,e2:qRevResults.E2,e3:qRevResults.E3,avg,verdict,title:polRv.title,auditScore:audit.overall_score||null};
      setRvPaper(polRv);setRvResult(rvRes);
      setRvHistory(prev=>[...prev,{round:prev.length+1,date:new Date().toLocaleDateString(),e1:e1s,e2:e2s,e3:e3s,avg,verdict}]);

      const totalTime=Math.round((Date.now()-t0)/1000);
      setQResult({paper:rawPaper,polished:polRv,review:rvRes,outline:outline,audit:audit,callCount:callCount,timeSec:totalTime});
      setQStep(6);
      pl(`${t.quickDone} · ${isZh?"调用":"calls"} ${callCount} · ${isZh?"耗时":"time"} ${Math.floor(totalTime/60)}m${totalTime%60}s`,"#10b981");
      pl("── 📥 "+(isZh?"论文输出":"Paper Output")+" ──","#3b82f6");
      // Mark this paper as completed in student tracker (if logged in)
      markPaperDone().then(d=>{if(d)pl(`${isZh?"论文进度":"Papers"}: ${d.papers_completed}/${d.papers_target} (${d.progress_pct}%)`,"#8b5cf6");});
      setTimeout(()=>setQStep(7),500);
      // Reset to 0 after output step is visible for 2 seconds
      setTimeout(()=>setQStep(0),2500);
    }catch(e){
      if(e.name==="AbortError")pl(t.stopped,"#ef4444");
      else pl("✗ "+e.message,"#ef4444");
      setQStep(0);
    }
    setQBusy(false);
  },[qTopic,qDom,qBusy,t,lf,lang]);

  // ═══ Shared paper renderer ═══
  const renderP=(p,bar)=><div style={{flex:1,overflow:"auto",background:"#f5efe6"}}>{bar}
    <div style={{maxWidth:680,margin:"0 auto",padding:"32px 22px 60px",fontFamily:"'Source Serif 4','Noto Sans SC',serif"}}>
      <div style={{textAlign:"center",marginBottom:28}}><h1 style={{fontSize:19,fontWeight:700,color:"#1a1a1a",lineHeight:1.4,marginBottom:10}}>{p.title}</h1>
        <div style={{fontSize:13,color:"rgba(0,0,0,.85)"}}>Desheng Wang</div><div style={{fontSize:11,color:"rgba(0,0,0,.85)",fontStyle:"italic"}}>Demai International Pte. Ltd.</div></div>
      <div style={{height:1,background:"rgba(0,0,0,.12)",marginBottom:22}}/>
      {p.abs&&p.abs.trim()?<div style={{marginBottom:22}}>
        <div style={{fontSize:11,fontWeight:700,color:"rgba(0,0,0,.85)",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8,fontFamily:"sans-serif"}}>{t.abstract}</div>
        <div style={{fontSize:13,lineHeight:1.85,color:"rgba(0,0,0,.8)",textAlign:"justify",padding:"11px 14px",background:"rgba(0,0,0,.05)",borderRadius:6,borderLeft:"3px solid rgba(139,92,246,.2)"}}>{p.abs}</div>
        {(p.kw||[]).length>0&&<div style={{marginTop:5,fontSize:11,color:"rgba(0,0,0,.85)"}}><b>{t.keywords}:</b> {p.kw.join("; ")}</div>}
      </div>:null}
      <div style={{height:1,background:"rgba(0,0,0,.1)",marginBottom:20}}/>
      {(p.secs||[]).map((s,i)=><div key={i} style={{marginBottom:24}}><h2 style={{fontSize:15,fontWeight:700,color:"rgba(0,0,0,.8)",marginBottom:8}}>{s.num}. {s.title}</h2>
        <div style={{fontSize:13,lineHeight:1.85,color:"rgba(0,0,0,.8)",textAlign:"justify"}}>{s.content.split("\n").map((l,j)=>{const x=l.trim();if(!x)return <div key={j} style={{height:6}}/>;
          if(x.startsWith("### "))return <h3 key={j} style={{fontSize:13,fontWeight:700,color:"rgba(0,0,0,.8)",margin:"12px 0 6px"}}>{x.replace(/^###\s*/,"")}</h3>;
          if(/^\*?\*?(Theorem|Proposition|Lemma|Corollary|Definition)\s/.test(x))return <div key={j} style={{margin:"10px 0",padding:"9px 12px",borderRadius:5,background:"rgba(139,92,246,.03)",borderLeft:"3px solid rgba(139,92,246,.2)",fontSize:12.5}}>{x.replace(/\*\*/g,"")}</div>;
          return <p key={j} style={{marginBottom:5}}>{x}</p>;})}</div></div>)}
      {(p.refs||[]).length>0&&<div><div style={{height:1,background:"rgba(0,0,0,.1)",margin:"14px 0"}}/><h2 style={{fontSize:13,fontWeight:700,color:"rgba(0,0,0,.85)",marginBottom:8}}>{t.refs}</h2>
        <div style={{fontSize:11,lineHeight:1.8,color:"rgba(0,0,0,.85)"}}>{p.refs.map((r,i)=><div key={i} style={{marginBottom:2,paddingLeft:20,textIndent:-20}}>{r}</div>)}</div></div>}
    </div></div>;

  const toolbar=(p,extra,onClean)=><div style={{position:"sticky",top:0,zIndex:10,padding:"6px 16px",background:"rgba(250,246,240,.95)",backdropFilter:"blur(10px)",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
      <div style={{display:"flex",gap:4,alignItems:"center"}}>{extra}<span style={{fontSize:10,color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>{(p.secs||[]).length}{lang==="zh"?"节":"sec"} · {(p.secs||[]).reduce((s,x)=>s+x.content.split(/\s+/).length,0)}{lang==="zh"?"词":"w"}</span></div>
      <div style={{display:"flex",gap:3}}>
        {onClean&&<button onClick={onClean} style={{padding:"4px 10px",fontSize:10,borderRadius:4,border:"1px solid #ef444440",background:"#ef444408",color:"#ef4444",fontFamily:"monospace",fontWeight:600}}>{t.cleanBtn}</button>}
        <button onClick={()=>dl(wordHtml(p),"SDE_"+safeName(p)+".doc","application/msword")} style={{padding:"4px 10px",fontSize:10,borderRadius:4,border:"1px solid #3b82f640",background:"#3b82f608",color:"#3b82f6",fontFamily:"monospace",fontWeight:600}}>⬇ Word</button>
        <button onClick={()=>dl(mkMd(p),"SDE_"+safeName(p)+".md")} style={{padding:"4px 10px",fontSize:10,borderRadius:4,border:"1px solid #10b98140",background:"#10b98108",color:"#10b981",fontFamily:"monospace",fontWeight:600}}>⬇ MD</button>
        <Cp text={mkMd(p)} label={t.copyMd}/></div>
    </div>
    {cleanLog&&<div style={{marginTop:4,padding:"6px 10px",borderRadius:5,background:"rgba(239,68,68,.06)",border:"1px solid rgba(239,68,68,.1)"}}>
      {cleanLog.map((l,i)=><div key={i} style={{fontSize:9,color:l.includes("✓")?"#10b981":"#ef4444",fontFamily:"monospace",lineHeight:1.6}}>{l}</div>)}
      <button onClick={()=>setCleanLog(null)} style={{fontSize:8,color:"rgba(0,0,0,.8)",background:"none",border:"none",marginTop:2,cursor:"pointer"}}>✕ close</button>
    </div>}
  </div>;

  const logStyle={fontFamily:"monospace",fontSize:11,lineHeight:1.8};
  const logColor=m=>!m?"rgba(0,0,0,.85)":m.includes("✅")||m.includes("✓")?"#10b981":m.includes("✗")||m.includes("⏹")?"#ef4444":m.startsWith("◉")?"#8b5cf6":m.includes("──")?"rgba(0,0,0,.1)":"rgba(0,0,0,.8)";

  return(<div style={{height:"100vh",background:"#faf6f0",color:"#1a1a1a",fontFamily:"'Noto Sans SC',-apple-system,sans-serif",display:"flex",flexDirection:"column"}}>
    <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@400;600;700&family=Source+Serif+4:wght@400;600;700&display=swap');
      @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}
      @keyframes fireGlow{0%,100%{box-shadow:0 0 20px rgba(245,158,11,.3),0 0 60px rgba(239,68,68,.15)}50%{box-shadow:0 0 30px rgba(245,158,11,.5),0 0 80px rgba(239,68,68,.25)}}
      @keyframes ember{0%{transform:translateY(0) scale(1);opacity:.8}50%{opacity:1}100%{transform:translateY(-120px) scale(0);opacity:0}}
      @keyframes gridPulse{0%,100%{opacity:.03}50%{opacity:.08}}
      @keyframes titleFire{0%,100%{filter:brightness(1)}50%{filter:brightness(1.3)}}
      @keyframes floatUp{0%{transform:translateY(20px);opacity:0}100%{transform:translateY(0);opacity:1}}
      @keyframes dragonSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
      @keyframes clawOrbit{0%{transform:rotate(0deg) translateX(55px) rotate(0deg);opacity:.8}50%{opacity:1}100%{transform:rotate(360deg) translateX(55px) rotate(-360deg);opacity:.8}}
      @keyframes tokenBurn{0%{transform:translateY(0) scale(1);opacity:0}15%{opacity:.8}50%{transform:translateY(-30px) scale(1.2);opacity:.6}100%{transform:translateY(-60px) scale(0);opacity:0}}
      }
      *{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15);border-radius:2px}
      input,textarea,select{font-family:inherit;background:rgba(0,0,0,.03);color:#333;border:1px solid rgba(0,0,0,.15);border-radius:6px;outline:none;padding:8px 10px;font-size:12px;width:100%}
      input:focus,textarea:focus{border-color:#8b5cf6}button{font-family:inherit;cursor:pointer;transition:all .15s}.lb{font-size:10px;color:rgba(0,0,0,.85);letter-spacing:2px;margin-bottom:4px;font-family:monospace}`}</style>

        {/* ═══ GATE ═══ */}
    {tab==="gate"&&<div style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto",background:"#0a0a0f",position:"relative"}}>
      <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 50% 120%, rgba(239,68,68,.15) 0%, rgba(245,158,11,.08) 30%, transparent 70%)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 20% 0%, rgba(139,92,246,.12) 0%, transparent 50%)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",inset:0,backgroundImage:"linear-gradient(rgba(139,92,246,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(139,92,246,.04) 1px,transparent 1px)",backgroundSize:"60px 60px",animation:"gridPulse 4s ease-in-out infinite",pointerEvents:"none"}}/>
      {[20,45,70,35,60,85,10].map((left,i)=><div key={i} style={{position:"absolute",bottom:0,left:left+"%",width:3+i%3,height:3+i%3,borderRadius:3,background:["#f59e0b","#ef4444","#f59e0b","#8b5cf6","#ef4444","#f59e0b","#8b5cf6"][i],animation:"ember "+(3+i*0.5)+"s ease-out "+i*0.4+"s infinite",opacity:.3+i*.06}}/>)}
      <div style={{padding:"12px 20px",display:"flex",justifyContent:"flex-end",position:"relative",zIndex:10}}><button onClick={()=>setLang(lang==="zh"?"en":"zh")} style={{padding:"4px 14px",fontSize:10,fontWeight:600,borderRadius:5,background:"rgba(255,255,255,.06)",color:"rgba(255,255,255,.85)",border:"1px solid rgba(255,255,255,.2)"}}>{lang==="zh"?"English":"中文"}</button></div>
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"0 20px 40px",position:"relative",zIndex:10}}>
        <div style={{position:"relative",width:180,height:230,marginBottom:12}}>
          <svg viewBox="-5 -48 190 260" style={{width:180,height:230}}>
            <defs>
              <linearGradient id="dgL" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#fcd34d"/><stop offset="50%" stopColor="#c4b5fd"/><stop offset="100%" stopColor="#67e8f9"/></linearGradient>
              <linearGradient id="dgR" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stopColor="#fcd34d"/><stop offset="50%" stopColor="#c4b5fd"/><stop offset="100%" stopColor="#67e8f9"/></linearGradient>
              <linearGradient id="dgC" x1="50%" y1="0%" x2="50%" y2="100%"><stop offset="0%" stopColor="#fcd34d"/><stop offset="100%" stopColor="#c4b5fd"/></linearGradient>
              <radialGradient id="pearl"><stop offset="0%" stopColor="#fef9c3"/><stop offset="50%" stopColor="#fcd34d"/><stop offset="100%" stopColor="#c4b5fd" stopOpacity="0.5"/></radialGradient>
              <filter id="sf"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              <filter id="sf2"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>

            {/* ═══ 祥龙瑞气 · Auspicious Dragon · 和谐柔美 ═══ */}

            {/* ── 祥云 Auspicious Clouds ── */}
            <g opacity="0.15">
              <path d="M18,44 Q24,38 32,40 Q34,34 42,36 Q44,32 50,34 Q48,38 42,38 Q40,44 32,42 Q26,44 18,44Z" fill="#c4b5fd"/>
              <path d="M130,44 Q136,38 144,40 Q146,34 154,36 Q156,32 162,34 Q160,38 154,38 Q152,44 144,42 Q138,44 130,44Z" fill="#c4b5fd"/>
              <path d="M58,172 Q62,168 68,170 Q72,166 78,168 Q74,172 68,172 Q64,174 58,172Z" fill="#c4b5fd"/>
              <path d="M102,172 Q106,168 112,170 Q116,166 122,168 Q118,172 112,172 Q108,174 102,172Z" fill="#c4b5fd"/>
            </g>

            {/* ══════════════════════════════════════ */}
            {/* ── TOKEN 熊熊大火 · Roaring Blaze ── */}
            {/* ══════════════════════════════════════ */}

            {/* Heat glow — wild sway */}
            <ellipse cx="90" cy="6" rx="30" ry="36" fill="#dc2626" opacity="0.12" filter="url(#sf2)">
              <animate attributeName="cx" values="90;72;90;108;90" dur="1.8s" repeatCount="indefinite"/>
              <animate attributeName="ry" values="34;44;36;46;34" dur="1.5s" repeatCount="indefinite"/>
            </ellipse>

            {/* Outer flame — 5 tips VIOLENTLY swaying, whole body whips L↔R */}
            <path d="M66,32 Q62,20 68,8 Q72,-2 70,-14 Q74,-4 78,4 Q80,-6 78,-18 Q84,-6 86,2 Q88,-10 90,-26 Q92,-10 94,2 Q96,-6 100,-18 Q100,-6 102,4 Q106,-4 110,-14 Q108,-2 112,8 Q118,20 114,32 Q104,28 90,30 Q76,28 66,32Z" fill="#dc2626" opacity="0.4" filter="url(#sf)">
              <animate attributeName="d" values="M66,32 Q62,20 68,8 Q72,-2 70,-14 Q74,-4 78,4 Q80,-6 78,-18 Q84,-6 86,2 Q88,-10 90,-26 Q92,-10 94,2 Q96,-6 100,-18 Q100,-6 102,4 Q106,-4 110,-14 Q108,-2 112,8 Q118,20 114,32 Q104,28 90,30 Q76,28 66,32Z;M50,34 Q44,14 48,-2 Q50,-14 40,-26 Q54,-10 62,-2 Q58,-16 48,-32 Q64,-14 72,-4 Q66,-22 60,-42 Q76,-18 82,-2 Q82,-12 88,-22 Q86,-6 90,4 Q96,-4 104,-14 Q100,2 106,10 Q116,22 112,34 Q104,30 90,32 Q66,30 50,34Z;M66,32 Q62,20 68,8 Q72,-2 70,-14 Q74,-4 78,4 Q80,-6 78,-18 Q84,-6 86,2 Q88,-10 90,-26 Q92,-10 94,2 Q96,-6 100,-18 Q100,-6 102,4 Q106,-4 110,-14 Q108,-2 112,8 Q118,20 114,32 Q104,28 90,30 Q76,28 66,32Z;M80,34 Q78,18 84,4 Q86,-6 90,-14 Q88,-4 88,6 Q94,-10 102,-24 Q98,-6 98,2 Q104,-18 116,-40 Q110,-14 108,-2 Q114,-12 126,-28 Q118,-8 120,2 Q128,-8 136,-20 Q126,0 128,12 Q130,24 128,34 Q110,30 90,32 Q78,28 80,34Z" dur="1.8s" repeatCount="indefinite"/>
            </path>

            {/* Left flame tongues — life cycle: born small → grow tall → shrink → die */}
            {[[74,30,"#dc2626",4,1.6,0],[76,28,"#dc2626",3.5,1.8,0.3],[78,26,"#ef4444",2.5,1.4,0.6],[80,24,"#ef4444",2,2.0,0.9],[82,22,"#f59e0b",1.5,1.5,1.2]].map(([x,y,color,sw,dur,dl],i)=>
              <path key={"lf"+i} d={`M${x},${y} Q${x-4},${y-8} ${x-2},${y-14}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0">
                <animate attributeName="d" values={`M${x},${y} Q${x-2},${y-4} ${x-1},${y-6};M${x},${y} Q${x-10},${y-18} ${x-8},${y-34};M${x},${y} Q${x-14},${y-24} ${x-10},${y-46};M${x},${y} Q${x-8},${y-16} ${x-6},${y-28};M${x},${y} Q${x-2},${y-4} ${x-1},${y-6}`} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.6;0.5;0.3;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </path>
            )}
            {/* Right flame tongues — mirror life cycle */}
            {[[106,30,"#dc2626",4,1.7,0.1],[104,28,"#dc2626",3.5,1.9,0.4],[102,26,"#ef4444",2.5,1.5,0.7],[100,24,"#ef4444",2,2.1,1.0],[98,22,"#f59e0b",1.5,1.6,1.3]].map(([x,y,color,sw,dur,dl],i)=>
              <path key={"rf"+i} d={`M${x},${y} Q${x+4},${y-8} ${x+2},${y-14}`} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity="0">
                <animate attributeName="d" values={`M${x},${y} Q${x+2},${y-4} ${x+1},${y-6};M${x},${y} Q${x+10},${y-18} ${x+8},${y-34};M${x},${y} Q${x+14},${y-24} ${x+10},${y-46};M${x},${y} Q${x+8},${y-16} ${x+6},${y-28};M${x},${y} Q${x+2},${y-4} ${x+1},${y-6}`} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.6;0.5;0.3;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </path>
            )}

            {/* Center flame spike — breathes tall/short */}
            <path d="M88,12 Q87,0 90,-20 Q93,0 92,12" fill="#ef4444" opacity="0">
              <animate attributeName="d" values="M89,12 Q89,8 90,4 Q91,8 91,12;M88,10 Q87,-6 90,-32 Q93,-6 92,10;M87,8 Q85,-10 90,-46 Q95,-10 93,8;M88,10 Q87,-4 90,-24 Q93,-4 92,10;M89,12 Q89,8 90,4 Q91,8 91,12" dur="2.2s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0;0.35;0.5;0.3;0" dur="2.2s" repeatCount="indefinite"/>
            </path>
            {/* Second center spike — offset timing */}
            <path d="M87,14 Q86,2 90,-16 Q94,2 93,14" fill="#dc2626" opacity="0">
              <animate attributeName="d" values="M88,14 Q88,10 90,6 Q92,10 92,14;M87,10 Q86,-4 90,-28 Q94,-4 93,10;M86,8 Q84,-8 90,-40 Q96,-8 94,8;M87,10 Q86,-2 90,-20 Q94,-2 93,10;M88,14 Q88,10 90,6 Q92,10 92,14" dur="1.8s" begin="0.8s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0;0.3;0.45;0.25;0" dur="1.8s" begin="0.8s" repeatCount="indefinite"/>
            </path>

            {/* Middle flame body — pulses size */}
            <path d="M90,-8 Q84,2 80,12 Q76,22 78,30 Q82,18 86,8 Q88,2 90,-2 Q92,2 94,8 Q98,18 102,30 Q104,22 100,12 Q96,2 90,-8Z" fill="#ef4444" opacity="0.5">
              <animate attributeName="d" values="M90,-4 Q86,4 82,14 Q78,22 80,30 Q84,20 87,12 Q89,6 90,2 Q91,6 93,12 Q96,20 100,30 Q102,22 98,14 Q94,4 90,-4Z;M90,-18 Q80,-2 76,10 Q72,22 74,34 Q78,18 82,8 Q86,0 90,-10 Q94,0 98,8 Q102,18 106,34 Q108,22 104,10 Q100,-2 90,-18Z;M90,-4 Q86,4 82,14 Q78,22 80,30 Q84,20 87,12 Q89,6 90,2 Q91,6 93,12 Q96,20 100,30 Q102,22 98,14 Q94,4 90,-4Z" dur="1.6s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.3;0.55;0.3" dur="1.6s" repeatCount="indefinite"/>
            </path>
            {/* Deep red inner — pulses with body */}
            <path d="M90,-2 Q86,4 84,12 Q82,18 84,24 Q86,16 88,10 Q89,6 90,2 Q91,6 92,10 Q94,16 96,24 Q98,18 96,12 Q94,4 90,-2Z" fill="#b91c1c" opacity="0.4">
              <animate attributeName="d" values="M90,2 Q88,6 86,14 Q84,18 86,22 Q87,16 88,12 Q89,8 90,6 Q91,8 92,12 Q93,16 94,22 Q96,18 94,14 Q92,6 90,2Z;M90,-10 Q84,0 82,8 Q80,16 82,24 Q84,14 86,8 Q88,2 90,-4 Q92,2 94,8 Q96,14 98,24 Q100,16 98,8 Q96,0 90,-10Z;M90,2 Q88,6 86,14 Q84,18 86,22 Q87,16 88,12 Q89,8 90,6 Q91,8 92,12 Q93,16 94,22 Q96,18 94,14 Q92,6 90,2Z" dur="1.6s" begin="0.2s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.25;0.5;0.25" dur="1.6s" begin="0.2s" repeatCount="indefinite"/>
            </path>

            {/* Inner core — pulses bright/dim with size */}
            <ellipse cx="90" cy="14" rx="7" ry="10" fill="#fbbf24" opacity="0.15" filter="url(#sf)">
              <animate attributeName="ry" values="8;16;8" dur="1.6s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.12;0.35;0.12" dur="1.6s" repeatCount="indefinite"/>
            </ellipse>
            <ellipse cx="90" cy="14" rx="4" ry="6" fill="#fef9c3" opacity="0.1">
              <animate attributeName="ry" values="5;10;5" dur="1.4s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.06;0.2;0.06" dur="1.4s" repeatCount="indefinite"/>
            </ellipse>

            {/* ── TOKEN text burning in the inferno ── */}
            <text x="90" y="8" textAnchor="middle" dominantBaseline="middle" fill="#fef9c3" fontSize="9" fontWeight="900" fontFamily="monospace" letterSpacing="2" opacity="0.85" filter="url(#sf)">
              TOKEN
              <animate attributeName="opacity" values="0.7;1;0.7" dur="1.2s" repeatCount="indefinite"/>
              <animate attributeName="y" values="9;5;9" dur="1.2s" repeatCount="indefinite"/>
            </text>
            <text x="90" y="8" textAnchor="middle" dominantBaseline="middle" fill="#dc2626" fontSize="9" fontWeight="900" fontFamily="monospace" letterSpacing="2" opacity="0.5">
              TOKEN
              <animate attributeName="opacity" values="0.3;0.65;0.3" dur="1s" repeatCount="indefinite"/>
            </text>
            {/* Red-hot dissolving fragments rising */}
            <text x="78" y="2" textAnchor="middle" fill="#ef4444" fontSize="6" fontWeight="800" fontFamily="monospace" opacity="0">
              TO
              <animate attributeName="y" values="2;-16;-32" dur="2s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0;0.75;0" dur="2s" repeatCount="indefinite"/>
            </text>
            <text x="102" y="4" textAnchor="middle" fill="#dc2626" fontSize="6" fontWeight="800" fontFamily="monospace" opacity="0">
              KEN
              <animate attributeName="y" values="4;-14;-30" dur="2.3s" begin="0.4s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0;0.7;0" dur="2.3s" begin="0.4s" repeatCount="indefinite"/>
            </text>
            <text x="90" y="-2" textAnchor="middle" fill="#b91c1c" fontSize="5.5" fontWeight="900" fontFamily="monospace" opacity="0">
              T
              <animate attributeName="y" values="-2;-24;-42" dur="1.6s" begin="0.8s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0;0.8;0" dur="1.6s" begin="0.8s" repeatCount="indefinite"/>
            </text>

            {/* Red ember sparks shooting upward */}
            {[[80,2,1.8,0],[86,-6,1.5,0.2],[94,-6,1.6,0.5],[100,2,1.9,0.7],[74,10,2.0,1.0],[106,10,1.7,1.3],[90,-10,1.4,0.4],[84,6,2.1,1.6],[96,6,1.8,1.9],[90,14,1.5,0.9]].map(([x,y,dur,dl],i)=>
              <circle key={"sp"+i} cx={x} cy={y} r={i%3===0?"1.8":"1.2"} fill={i%4===0?"#fef9c3":i%4===1?"#fbbf24":i%4===2?"#ef4444":"#dc2626"} opacity="0">
                <animate attributeName="cy" values={y+";"+(-30-i*3)+";"+(-50-i*2)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.9;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="cx" values={x+";"+(x+(i%2===0?-5:5))+";"+x} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="r" values={(i%3===0?"1.8":"1.2")+";0.3;0"} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </circle>
            )}

            {/* Heat shimmer — red waves above fire */}
            <path d="M78,-16 Q84,-22 90,-20 Q96,-22 102,-16" fill="none" stroke="#ef4444" strokeWidth="0.6" opacity="0.2">
              <animate attributeName="d" values="M78,-16 Q84,-22 90,-20 Q96,-22 102,-16;M78,-18 Q84,-24 90,-22 Q96,-24 102,-18;M78,-16 Q84,-22 90,-20 Q96,-22 102,-16" dur="0.8s" repeatCount="indefinite"/>
            </path>
            <path d="M74,-8 Q82,-14 90,-12 Q98,-14 106,-8" fill="none" stroke="#dc2626" strokeWidth="0.5" opacity="0.15">
              <animate attributeName="d" values="M74,-8 Q82,-14 90,-12 Q98,-14 106,-8;M74,-10 Q82,-16 90,-14 Q98,-16 106,-10;M74,-8 Q82,-14 90,-12 Q98,-14 106,-8" dur="1s" repeatCount="indefinite"/>
            </path>
            <path d="M82,-26 Q86,-30 90,-28 Q94,-30 98,-26" fill="none" stroke="#ef4444" strokeWidth="0.4" opacity="0.12">
              <animate attributeName="d" values="M82,-26 Q86,-30 90,-28 Q94,-30 98,-26;M82,-28 Q86,-32 90,-30 Q94,-32 98,-28;M82,-26 Q86,-30 90,-28 Q94,-30 98,-26" dur="0.7s" repeatCount="indefinite"/>
            </path>

            {/* Sparks / embers rising — red-hot */}
            {[[80,0,2.2,0],[86,-4,1.8,0.3],[94,-4,2.0,0.6],[100,0,2.4,0.9],[76,8,2.6,1.2],[104,8,1.9,1.5],[90,-8,2.1,0.4],[84,4,2.5,1.8]].map(([x,y,dur,dl],i)=>
              <circle key={"sp"+i} cx={x} cy={y} r={i%2===0?"1.5":"1"} fill={i%3===0?"#fbbf24":i%3===1?"#ef4444":"#dc2626"} opacity="0">
                <animate attributeName="cy" values={y+";"+(-25-i*3)+";"+(-45-i*2)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.9;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="cx" values={x+";"+(x+(i%2===0?-5:5))+";"+x} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="r" values={(i%2===0?"1.5":"1")+";0.3;0"} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </circle>
            )}

            {/* Heat shimmer lines — redder */}
            <path d="M82,-10 Q86,-16 90,-14 Q94,-16 98,-10" fill="none" stroke="#ef4444" strokeWidth="0.5" opacity="0.2">
              <animate attributeName="d" values="M82,-10 Q86,-16 90,-14 Q94,-16 98,-10;M82,-12 Q86,-18 90,-16 Q94,-18 98,-12;M82,-10 Q86,-16 90,-14 Q94,-16 98,-10" dur="1s" repeatCount="indefinite"/>
            </path>
            <path d="M78,-4 Q84,-10 90,-8 Q96,-10 102,-4" fill="none" stroke="#dc2626" strokeWidth="0.4" opacity="0.15">
              <animate attributeName="d" values="M78,-4 Q84,-10 90,-8 Q96,-10 102,-4;M78,-6 Q84,-12 90,-10 Q96,-12 102,-6;M78,-4 Q84,-10 90,-8 Q96,-10 102,-4" dur="1.2s" repeatCount="indefinite"/>
            </path>

            {/* ══════════════════════════════════════════════ */}
            {/* ── 龙身·六爪锻造链 The Forging Chain ── */}
            {/* TOKEN(火)→ 抓核/裂缝 → 重组/改姓 → 锻造/投放 → 武器 */}
            {/* ══════════════════════════════════════════════ */}

            {/* Body spines — forge heat flowing down */}
            <path d="M80,32 Q62,42 38,56 Q18,68 18,88 Q18,104 26,120 Q34,138 42,154 Q54,172 90,186" fill="none" stroke="url(#dgL)" strokeWidth="2.2" strokeLinecap="round" filter="url(#sf)" opacity="0.5">
              <animate attributeName="opacity" values="0.35;0.6;0.35" dur="4s" repeatCount="indefinite"/>
            </path>
            <path d="M100,32 Q118,42 142,56 Q162,68 162,88 Q162,104 154,120 Q146,138 138,154 Q126,172 90,186" fill="none" stroke="url(#dgR)" strokeWidth="2.2" strokeLinecap="round" filter="url(#sf)" opacity="0.5">
              <animate attributeName="opacity" values="0.35;0.6;0.35" dur="4s" begin="0.3s" repeatCount="indefinite"/>
            </path>

            {/* Forge flow particles — material flowing down the body */}
            {[[75,36,2.8,0,"L"],[105,36,3.0,0.4,"R"],[55,60,2.5,0.8,"L"],[125,60,2.7,1.2,"R"],[30,90,3.2,1.6,"L"],[150,90,2.9,2.0,"R"],[40,130,2.6,2.4,"L"],[140,130,3.1,2.8,"R"]].map(([x,y,dur,dl,side],i)=>
              <circle key={"ff"+i} cx={x} cy={y} r="1.5" fill={i<4?"#fcd34d":i<6?"#c4b5fd":"#67e8f9"} opacity="0">
                <animate attributeName="cy" values={y+";"+(y+40)+";"+(y+80)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.6;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </circle>
            )}

            {/* ── STAGE 1: 抓核 + 抓裂缝 (Capture) ── */}
            {/* Stage label */}
            <text x="90" y="50" textAnchor="middle" fill="#fcd34d" fontSize="3.5" fontWeight="600" fontFamily="monospace" opacity="0.55">CAPTURE</text>
            {/* Left: 抓核 — Core Capture */}
            <g>
              <polygon points="38,46 47,51 47,61 38,66 29,61 29,51" fill="#fcd34d" opacity="0.08" stroke="#fcd34d" strokeWidth="0.6" filter="url(#sf)">
                <animate attributeName="opacity" values="0.05;0.2;0.08;0.25;0.04;0.18;0.06;0.22;0.05" dur="2.7s" repeatCount="indefinite"/>
              </polygon>
              <circle cx="38" cy="56" r="5.5" fill="#fcd34d" opacity="0.5" filter="url(#sf)">
                <animate attributeName="r" values="5;6.5;5;7;4.5;6;5.5;5" dur="2.1s" repeatCount="indefinite"/>
              </circle>
              <text x="38" y="57" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="6" fontWeight="800" fontFamily="'Noto Sans SC',sans-serif" opacity="0.9">抓</text>
              <text x="22" y="57" textAnchor="middle" fill="#fcd34d" fontSize="4.5" fontWeight="500" opacity="0.6" fontFamily="'Noto Sans SC',sans-serif">核</text>
              {/* Target crosshair icon */}
              <circle cx="38" cy="56" r="9" fill="none" stroke="#fcd34d" strokeWidth="0.4" strokeDasharray="2,2" opacity="0.2"><animate attributeName="r" values="8;11;8" dur="3s" repeatCount="indefinite"/></circle>
              {/* Claw scratches */}
              <line x1="26" y1="52" x2="20" y2="50" stroke="#fcd34d" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="26" y1="56" x2="19" y2="56" stroke="#fcd34d" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="26" y1="60" x2="20" y2="62" stroke="#fcd34d" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
            </g>
            {/* Right: 裂缝 — Fracture Detection */}
            <g>
              <polygon points="142,46 151,51 151,61 142,66 133,61 133,51" fill="#fcd34d" opacity="0.08" stroke="#fcd34d" strokeWidth="0.6" filter="url(#sf)">
                <animate attributeName="opacity" values="0.06;0.22;0.04;0.18;0.08;0.24;0.05;0.15;0.06" dur="3.1s" begin="0.4s" repeatCount="indefinite"/>
              </polygon>
              <circle cx="142" cy="56" r="5.5" fill="#fcd34d" opacity="0.5" filter="url(#sf)">
                <animate attributeName="r" values="5;7;5.5;6;4.5;6.5;5;7;5" dur="2.7s" begin="0.3s" repeatCount="indefinite"/>
              </circle>
              <text x="142" y="57" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="6" fontWeight="800" fontFamily="'Noto Sans SC',sans-serif" opacity="0.9">裂</text>
              <text x="158" y="57" textAnchor="middle" fill="#fcd34d" fontSize="4.5" fontWeight="500" opacity="0.6" fontFamily="'Noto Sans SC',sans-serif">缝</text>
              {/* Crack icon - zigzag */}
              <path d="M148,49 L150,53 L146,57 L150,61 L148,63" fill="none" stroke="#fcd34d" strokeWidth="0.8" strokeLinecap="round" opacity="0.35"/>
              {/* Claw scratches */}
              <line x1="154" y1="52" x2="160" y2="50" stroke="#fcd34d" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="154" y1="56" x2="161" y2="56" stroke="#fcd34d" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="154" y1="60" x2="160" y2="62" stroke="#fcd34d" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
            </g>
            {/* Stage 1→2 flow arrow */}
            <path d="M38,68 Q44,78 36,88" fill="none" stroke="#fcd34d" strokeWidth="0.5" strokeDasharray="2,3" opacity="0.2"><animate attributeName="strokeDashoffset" values="0;-10" dur="2s" repeatCount="indefinite"/></path>
            <path d="M142,68 Q136,78 144,88" fill="none" stroke="#fcd34d" strokeWidth="0.5" strokeDasharray="2,3" opacity="0.2"><animate attributeName="strokeDashoffset" values="0;-10" dur="2s" repeatCount="indefinite"/></path>

            {/* ── STAGE 2: 重组 + 改姓 (Transform) ── */}
            <text x="90" y="90" textAnchor="middle" fill="#c4b5fd" fontSize="3.5" fontWeight="600" fontFamily="monospace" opacity="0.55">TRANSFORM</text>
            {/* Left: 重组 */}
            <g>
              <polygon points="26,86 35,91 35,101 26,106 17,101 17,91" fill="#c4b5fd" opacity="0.08" stroke="#c4b5fd" strokeWidth="0.6" filter="url(#sf)">
                <animate attributeName="opacity" values="0.04;0.18;0.07;0.2;0.05;0.22;0.08;0.14;0.04" dur="2.3s" repeatCount="indefinite"/>
              </polygon>
              <circle cx="26" cy="96" r="5.5" fill="#c4b5fd" opacity="0.5" filter="url(#sf)">
                <animate attributeName="r" values="5;6;4.5;7;5.5;6.5;5" dur="1.9s" repeatCount="indefinite"/>
              </circle>
              <text x="26" y="97" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="6" fontWeight="800" fontFamily="'Noto Sans SC',sans-serif" opacity="0.9">重</text>
              <text x="10" y="97" textAnchor="middle" fill="#c4b5fd" fontSize="4.5" fontWeight="500" opacity="0.6" fontFamily="'Noto Sans SC',sans-serif">组</text>
              {/* Recombination icon - rotating arrows */}
              <path d="M20,90 Q22,86 26,86 M32,102 Q28,106 24,104" fill="none" stroke="#c4b5fd" strokeWidth="0.6" strokeLinecap="round" opacity="0.3"/>
              <line x1="14" y1="92" x2="8" y2="90" stroke="#c4b5fd" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="14" y1="96" x2="7" y2="96" stroke="#c4b5fd" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="14" y1="100" x2="8" y2="102" stroke="#c4b5fd" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
            </g>
            {/* Right: 改姓 */}
            <g>
              <polygon points="154,86 163,91 163,101 154,106 145,101 145,91" fill="#c4b5fd" opacity="0.08" stroke="#c4b5fd" strokeWidth="0.6" filter="url(#sf)">
                <animate attributeName="opacity" values="0.07;0.24;0.05;0.16;0.06;0.2;0.04;0.22;0.07" dur="2.9s" begin="0.6s" repeatCount="indefinite"/>
              </polygon>
              <circle cx="154" cy="96" r="5.5" fill="#c4b5fd" opacity="0.5" filter="url(#sf)">
                <animate attributeName="r" values="5;6.5;5;4.5;7;6;5.5;5" dur="2.5s" begin="0.5s" repeatCount="indefinite"/>
              </circle>
              <text x="154" y="97" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="6" fontWeight="800" fontFamily="'Noto Sans SC',sans-serif" opacity="0.9">改</text>
              <text x="170" y="97" textAnchor="middle" fill="#c4b5fd" fontSize="4.5" fontWeight="500" opacity="0.6" fontFamily="'Noto Sans SC',sans-serif">姓</text>
              {/* Translation icon — A→B */}
              <text x="161" y="90" fill="#c4b5fd" fontSize="3.5" fontFamily="monospace" opacity="0.3">A→B</text>
              <line x1="166" y1="92" x2="172" y2="90" stroke="#c4b5fd" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="166" y1="96" x2="173" y2="96" stroke="#c4b5fd" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="166" y1="100" x2="172" y2="102" stroke="#c4b5fd" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
            </g>
            {/* Stage 2→3 flow arrow */}
            <path d="M26,108 Q32,120 38,132" fill="none" stroke="#c4b5fd" strokeWidth="0.5" strokeDasharray="2,3" opacity="0.2"><animate attributeName="strokeDashoffset" values="0;-10" dur="2s" repeatCount="indefinite"/></path>
            <path d="M154,108 Q148,120 142,132" fill="none" stroke="#c4b5fd" strokeWidth="0.5" strokeDasharray="2,3" opacity="0.2"><animate attributeName="strokeDashoffset" values="0;-10" dur="2s" repeatCount="indefinite"/></path>

            {/* ── STAGE 3: 锻造 + 投放 (Forge & Deploy) ── */}
            <text x="90" y="138" textAnchor="middle" fill="#67e8f9" fontSize="3.5" fontWeight="600" fontFamily="monospace" opacity="0.55">FORGE ⚔ DEPLOY</text>
            {/* Left: 锻造 */}
            <g>
              <polygon points="40,136 49,141 49,151 40,156 31,151 31,141" fill="#67e8f9" opacity="0.08" stroke="#67e8f9" strokeWidth="0.6" filter="url(#sf)">
                <animate attributeName="opacity" values="0.05;0.16;0.08;0.22;0.04;0.2;0.07;0.18;0.05" dur="3.3s" repeatCount="indefinite"/>
              </polygon>
              <circle cx="40" cy="146" r="5.5" fill="#67e8f9" opacity="0.5" filter="url(#sf)">
                <animate attributeName="r" values="5;7;5.5;4.5;6.5;5;6;5" dur="2.3s" repeatCount="indefinite"/>
              </circle>
              <text x="40" y="147" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="6" fontWeight="800" fontFamily="'Noto Sans SC',sans-serif" opacity="0.9">锻</text>
              <text x="24" y="147" textAnchor="middle" fill="#67e8f9" fontSize="4.5" fontWeight="500" opacity="0.6" fontFamily="'Noto Sans SC',sans-serif">造</text>
              {/* Anvil spark */}
              <circle cx="34" cy="139" r="1" fill="#67e8f9" opacity="0"><animate attributeName="opacity" values="0;0.6;0" dur="1.5s" repeatCount="indefinite"/></circle>
              <line x1="28" y1="142" x2="22" y2="140" stroke="#67e8f9" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="28" y1="146" x2="21" y2="146" stroke="#67e8f9" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="28" y1="150" x2="22" y2="152" stroke="#67e8f9" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
            </g>
            {/* Right: 投放 */}
            <g>
              <polygon points="140,136 149,141 149,151 140,156 131,151 131,141" fill="#67e8f9" opacity="0.08" stroke="#67e8f9" strokeWidth="0.6" filter="url(#sf)">
                <animate attributeName="opacity" values="0.08;0.2;0.04;0.24;0.06;0.14;0.05;0.22;0.08" dur="2.5s" begin="0.3s" repeatCount="indefinite"/>
              </polygon>
              <circle cx="140" cy="146" r="5.5" fill="#67e8f9" opacity="0.5" filter="url(#sf)">
                <animate attributeName="r" values="5;6;7;5.5;4.5;6.5;5" dur="2.8s" begin="0.2s" repeatCount="indefinite"/>
              </circle>
              <text x="140" y="147" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize="6" fontWeight="800" fontFamily="'Noto Sans SC',sans-serif" opacity="0.9">投</text>
              <text x="156" y="147" textAnchor="middle" fill="#67e8f9" fontSize="4.5" fontWeight="500" opacity="0.6" fontFamily="'Noto Sans SC',sans-serif">放</text>
              {/* Launch arrow */}
              <path d="M148,140 L154,136 L152,142" fill="none" stroke="#67e8f9" strokeWidth="0.7" strokeLinecap="round" opacity="0.35"/>
              <line x1="152" y1="142" x2="158" y2="140" stroke="#67e8f9" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="152" y1="146" x2="159" y2="146" stroke="#67e8f9" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
              <line x1="152" y1="150" x2="158" y2="152" stroke="#67e8f9" strokeWidth="1" strokeLinecap="round" opacity="0.3"/>
            </g>

            {/* ── SC Forge energy connections to all 6 claws ── */}
            <line x1="55" y1="96" x2="38" y2="56" stroke="#fcd34d" strokeWidth="0.3" strokeDasharray="2,4" opacity="0.12"/>
            <line x1="125" y1="96" x2="142" y2="56" stroke="#fcd34d" strokeWidth="0.3" strokeDasharray="2,4" opacity="0.12"/>
            <line x1="50" y1="100" x2="26" y2="96" stroke="#c4b5fd" strokeWidth="0.3" strokeDasharray="2,4" opacity="0.12"/>
            <line x1="130" y1="100" x2="154" y2="96" stroke="#c4b5fd" strokeWidth="0.3" strokeDasharray="2,4" opacity="0.12"/>
            <line x1="55" y1="106" x2="40" y2="146" stroke="#67e8f9" strokeWidth="0.3" strokeDasharray="2,4" opacity="0.12"/>
            <line x1="125" y1="106" x2="140" y2="146" stroke="#67e8f9" strokeWidth="0.3" strokeDasharray="2,4" opacity="0.12"/>

            {/* ── SC Furnace ring ── */}
            <circle cx="90" cy="100" r="26" fill="none" stroke="#c4b5fd" strokeWidth="0.3" opacity="0.08">
              <animate attributeName="r" values="24;28;24" dur="5s" repeatCount="indefinite"/>
            </circle>

            {/* ══ 火星四射 · Sparks flying in ALL directions from forge ══ */}
            {/* 16 sparks at different angles, staggered timing, varied speed */}
            {[
              [0,-1,1.8,0,"#fbbf24"],      /* ↑ up */
              [0.7,-0.7,2.0,0.3,"#ef4444"], /* ↗ */
              [1,0,1.6,0.6,"#fbbf24"],      /* → right */
              [0.7,0.7,2.2,0.9,"#dc2626"],  /* ↘ */
              [0,1,1.9,1.2,"#ef4444"],      /* ↓ down */
              [-0.7,0.7,1.7,1.5,"#fbbf24"], /* ↙ */
              [-1,0,2.1,1.8,"#dc2626"],     /* ← left */
              [-0.7,-0.7,1.8,2.1,"#ef4444"],/* ↖ */
              [0.4,-0.9,2.3,0.4,"#fcd34d"], /* ↑↗ */
              [0.9,-0.4,1.5,1.0,"#dc2626"], /* →↗ */
              [0.9,0.4,2.0,1.6,"#fbbf24"],  /* →↘ */
              [-0.4,0.9,1.7,0.7,"#ef4444"], /* ↓↙ */
              [-0.9,0.4,2.4,2.0,"#fcd34d"], /* ←↙ */
              [-0.9,-0.4,1.6,1.3,"#dc2626"],/* ←↖ */
              [0.3,0.95,2.1,0.5,"#fbbf24"], /* ↓↘ */
              [-0.3,-0.95,1.9,1.7,"#ef4444"]/* ↑↖ */
            ].map(([dx,dy,dur,dl,color],i)=>
              <circle key={"sk"+i} cx="90" cy="100" r="3" fill={color} opacity="0">
                <animate attributeName="cx" values={"90;"+(90+dx*20)+";"+(90+dx*45)+";"+(90+dx*65)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="cy" values={"100;"+(100+dy*20)+";"+(100+dy*45)+";"+(100+dy*65)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.8;0.5;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="r" values="3.5;2.5;1;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </circle>
            )}
            {/* Tiny micro-sparks — rapid, short range, many */}
            {[
              [30,1.0,0,"#fcd34d"],[75,1.2,0.2,"#ef4444"],[120,0.9,0.4,"#fbbf24"],
              [165,1.1,0.6,"#dc2626"],[210,1.3,0.8,"#fcd34d"],[255,0.8,1.0,"#ef4444"],
              [300,1.0,1.2,"#fbbf24"],[345,1.2,1.4,"#dc2626"],
              [50,0.7,0.3,"#fef9c3"],[140,0.9,0.9,"#fef9c3"],[230,0.8,1.5,"#fef9c3"],[320,1.0,0.1,"#fef9c3"]
            ].map(([angle,dur,dl,color],i)=>{
              const rad=angle*Math.PI/180;const dx=Math.cos(rad);const dy=Math.sin(rad);
              return <circle key={"mk"+i} cx="90" cy="100" r="2" fill={color} opacity="0">
                <animate attributeName="cx" values={"90;"+(90+dx*12)+";"+(90+dx*28)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="cy" values={"100;"+(100+dy*12)+";"+(100+dy*28)} dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0;0.9;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
                <animate attributeName="r" values="2.5;1.5;0" dur={dur+"s"} begin={dl+"s"} repeatCount="indefinite"/>
              </circle>;
            })}

            {/* ── Tail: Weapon Output — 武器出口 ── */}
            <path d="M90,186 L90,198" stroke="url(#dgC)" strokeWidth="1.5" strokeLinecap="round" opacity="0.3"/>
            {/* Weapon symbol at tail */}
            <text x="90" y="196" textAnchor="middle" fill="#67e8f9" fontSize="6" opacity="0.55">⚔</text>
            <text x="90" y="204" textAnchor="middle" fill="#67e8f9" fontSize="3" fontFamily="monospace" opacity="0.45">WEAPON</text>
          </svg>

          {/* Center SC badge — The Forge */}
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:46,height:46,borderRadius:13,background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",boxShadow:"0 0 20px rgba(139,92,246,.4)",letterSpacing:1}}>
            <div style={{fontSize:16,fontWeight:900,color:"#fff",fontFamily:"monospace",lineHeight:1}}>SC</div>
            <div style={{fontSize:5,color:"rgba(255,255,255,.8)",fontFamily:"monospace",marginTop:1}}>FORGE</div>
          </div>
        </div>
        <div style={{fontSize:36,fontWeight:900,background:"linear-gradient(135deg,#f59e0b 0%,#ef4444 30%,#8b5cf6 60%,#06b6d4 100%)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",marginBottom:6,letterSpacing:2,animation:"titleFire 4s ease-in-out infinite"}}>SDEClaw-GCG</div>
        <div style={{fontSize:15,color:"rgba(255,255,255,.95)",fontWeight:500,marginBottom:6}}>{lang==="zh"?"龙爪手 · 科研自动化系统":"Dragon Claw · Research Automation"}</div>
        <div style={{fontSize:10,color:"rgba(255,255,255,.55)",fontFamily:"monospace",marginBottom:44,letterSpacing:2}}>{lang==="zh"?"裂缝第一 · 六爪锻造 · 武器改姓 · 学科投放":"Crack-First · Six-Claw · Weapon Rename · Deploy"}</div>
        <div style={{display:"flex",gap:16,maxWidth:700,width:"100%",flexWrap:"wrap",justifyContent:"center"}}>
          <div onClick={()=>setGateTarget("quick")} style={{flex:1,minWidth:280,maxWidth:320,borderRadius:16,cursor:"pointer",overflow:"hidden",background:"rgba(255,255,255,.07)",border:"1px solid rgba(245,158,11,.35)",backdropFilter:"blur(10px)",animation:"floatUp .6s ease-out"}}>
            <div style={{padding:"28px 24px 20px",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}><div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#f59e0b,#ef4444)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:"0 4px 20px rgba(245,158,11,.4)"}}>⚡</div><div><div style={{fontSize:18,fontWeight:700,color:"#fff"}}>{lang==="zh"?"直接生成":"Direct Generate"}</div><div style={{fontSize:10,color:"rgba(255,255,255,.7)",fontFamily:"monospace"}}>{lang==="zh"?"一键完成 · 自动流转":"One-click · Auto"}</div></div></div>
              <div style={{fontSize:12,color:"rgba(255,255,255,.8)",lineHeight:1.8,marginBottom:16}}>{lang==="zh"?"输入课题 → 自动完成全流程":"Input topic → Auto-complete all steps"}</div>
              <div style={{display:"flex",gap:3}}>{["🔬","→","💡","→","📄","→","🔧","→","⭐","→","📥"].map((e,i)=><span key={i} style={{fontSize:i%2===0?13:8,color:i%2===0?"rgba(255,255,255,.9)":"rgba(255,255,255,.4)"}}>{e}</span>)}</div>
            </div>
            <div style={{padding:"12px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:10,color:"rgba(255,255,255,.5)",fontFamily:"monospace"}}>{lang==="zh"?"2~20分钟":"2-20 min"}</span><div style={{padding:"7px 20px",borderRadius:7,fontSize:12,fontWeight:700,background:"linear-gradient(135deg,#f59e0b,#ef4444)",color:"#fff"}}>{lang==="zh"?"进入 →":"Enter →"}</div></div>
          </div>
          <div onClick={()=>setGateTarget("papers")} style={{flex:1,minWidth:280,maxWidth:320,borderRadius:16,cursor:"pointer",overflow:"hidden",background:"rgba(255,255,255,.07)",border:"1px solid rgba(139,92,246,.35)",backdropFilter:"blur(10px)",animation:"floatUp .6s ease-out .15s both"}}>
            <div style={{padding:"28px 24px 20px",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}><div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,boxShadow:"0 4px 20px rgba(139,92,246,.4)"}}>🐉</div><div><div style={{fontSize:18,fontWeight:700,color:"#fff"}}>{lang==="zh"?"合作共建":"Collaborative Build"}</div><div style={{fontSize:10,color:"rgba(255,255,255,.7)",fontFamily:"monospace"}}>{lang==="zh"?"分步参与 · 人机协同":"Step-by-step · Human-AI"}</div></div></div>
              <div style={{fontSize:12,color:"rgba(255,255,255,.8)",lineHeight:1.8,marginBottom:16}}>{lang==="zh"?"每步可审阅、修改、重做":"Review, modify, redo at each step"}</div>
              <div style={{display:"flex",gap:6}}>{[{n:lang==="zh"?"文章":"In",c:"#ec4899",i:"📚"},{n:lang==="zh"?"研究":"Res",c:"#ef4444",i:"🔬"},{n:lang==="zh"?"灵感":"Ins",c:"#f59e0b",i:"💡"},{n:lang==="zh"?"论文":"Pap",c:"#8b5cf6",i:"📄"},{n:lang==="zh"?"打磨":"Pol",c:"#10b981",i:"🔧"},{n:lang==="zh"?"审稿":"Rev",c:"#f97316",i:"⭐"}].map((d,i)=><div key={i} style={{flex:1,textAlign:"center"}}><div style={{fontSize:14,marginBottom:2}}>{d.i}</div><div style={{fontSize:7,color:d.c,fontFamily:"monospace",fontWeight:600}}>{d.n}</div></div>)}</div>
            </div>
            <div style={{padding:"12px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:10,color:"rgba(255,255,255,.5)",fontFamily:"monospace"}}>{lang==="zh"?"深度模式":"Deep mode"}</span><div style={{padding:"7px 20px",borderRadius:7,fontSize:12,fontWeight:700,background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",color:"#fff"}}>{lang==="zh"?"进入 →":"Enter →"}</div></div>
          </div>
        </div>
        <div style={{marginTop:36,fontSize:12,color:"rgba(255,255,255,.55)",fontStyle:"italic",textAlign:"center",maxWidth:520}}>{lang==="zh"?"\"知识创新始于对裂缝的高敏感抓取。龙爪手不是说新，而是打新。\"":"\"Innovation starts from seizing cracks. Dragon Claw forges new.\""}</div>
        <div style={{marginTop:24,fontSize:9,color:"rgba(255,255,255,.4)",fontFamily:"monospace",textAlign:"center"}}>
          SDEClaw-GCG v0.7 · Gemini · Claude · GPT<br/>
          <span style={{color:"rgba(255,255,255,.3)"}}>Internal Team Testing · Full Premium Tier · Demai International Pte. Ltd.</span>
        </div>
      </div>
      {gateTarget&&<div style={{position:"absolute",inset:0,background:"rgba(0,0,0,.4)",backdropFilter:"blur(8px)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:20}}>
        <div style={{background:"#fff",borderRadius:16,padding:"28px 24px",maxWidth:420,width:"100%",boxShadow:"0 20px 60px rgba(0,0,0,.2)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}><div style={{width:36,height:36,borderRadius:10,background:gateTarget==="quick"?"linear-gradient(135deg,#f59e0b,#ef4444)":"linear-gradient(135deg,#8b5cf6,#06b6d4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{gateTarget==="quick"?"⚡":"🐉"}</div><div><div style={{fontSize:16,fontWeight:700,color:"#111"}}>{gateTarget==="quick"?(lang==="zh"?"直接生成":"Direct Generate"):(lang==="zh"?"合作共建":"Collaborative Build")}</div><div style={{fontSize:11,color:"rgba(0,0,0,.5)"}}>{lang==="zh"?"选择或新建项目":"Choose or create a project"}</div></div></div>
          <div style={{display:"flex",gap:6,marginBottom:16}}><input value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder={lang==="zh"?"输入新项目名称...":"New project name..."} style={{flex:1,padding:"10px 12px",fontSize:13}} onKeyDown={e=>{if(e.key==="Enter"&&saveName.trim()){newProject();saveProject(saveName.trim());setEntryMode(gateTarget==="quick"?"quick":"collab");setTab(gateTarget);setGateTarget(null);}}}/><button onClick={()=>{if(saveName.trim()){newProject();saveProject(saveName.trim());setEntryMode(gateTarget==="quick"?"quick":"collab");setTab(gateTarget);setGateTarget(null);}}} disabled={!saveName.trim()} style={{padding:"10px 16px",fontSize:12,fontWeight:700,borderRadius:6,border:"none",background:saveName.trim()?"linear-gradient(135deg,#10b981,#06b6d4)":"rgba(0,0,0,.08)",color:saveName.trim()?"#fff":"rgba(0,0,0,.3)"}}>{lang==="zh"?"新建":"Create"}</button></div>
          {projList.filter(k=>k!=="proj:__autosave__").length>0&&<div style={{marginBottom:12}}><div style={{fontSize:11,fontWeight:600,color:"rgba(0,0,0,.5)",marginBottom:6}}>{lang==="zh"?"已有项目:":"Existing projects:"}</div><div style={{maxHeight:200,overflow:"auto"}}>{projList.filter(k=>k!=="proj:__autosave__").map((key,i)=>{const name=key.replace("proj:","");return <div key={i} onClick={async()=>{await loadProject(key,true);setEntryMode(gateTarget==="quick"?"quick":"collab");setTab(gateTarget);setGateTarget(null);}} style={{padding:"10px 14px",marginBottom:4,borderRadius:8,cursor:"pointer",background:"rgba(139,92,246,.03)",border:"1px solid rgba(139,92,246,.1)"}}><span style={{fontSize:13,fontWeight:600,color:"#111"}}>{name}</span></div>;})}</div></div>}
          <button onClick={()=>{setEntryMode(gateTarget==="quick"?"quick":"collab");setTab(gateTarget);setGateTarget(null);}} style={{width:"100%",padding:"10px",fontSize:12,fontWeight:600,borderRadius:8,border:"1px solid rgba(0,0,0,.1)",background:"rgba(0,0,0,.02)",color:"rgba(0,0,0,.5)"}}>{lang==="zh"?"跳过，直接进入":"Skip — enter directly"}</button>
        </div>
      </div>}
    </div>}

{/* Header — hidden on gate */}
    {tab!=="gate"&&<div style={{padding:"8px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",gap:4}}>
        <button onClick={goHome} style={{padding:"2px 6px",fontSize:14,borderRadius:5,border:"1px solid rgba(139,92,246,.2)",background:"rgba(139,92,246,.06)",color:"#8b5cf6",cursor:"pointer",lineHeight:1,fontWeight:600}} title={lang==="zh"?"保存并返回首页":"Save & Home"}>←</button>
        <div style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer"}} onClick={goHome}>
          <div style={{width:22,height:22,borderRadius:4,background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:800,color:"#fff",fontFamily:"monospace",transition:"transform .15s"}} onMouseEnter={e=>e.currentTarget.style.transform="scale(1.12)"} onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>SC</div>
          <span style={{fontSize:12,fontWeight:700,background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>SDEClaw-GCG</span>
        </div>
      </div>
      <div style={{display:"flex",gap:6,alignItems:"center"}}>
        <StudentBadge lang={lang}/>
        <button onClick={()=>setLang(lang==="zh"?"en":"zh")} style={{padding:"3px 7px",fontSize:9,fontWeight:600,borderRadius:4,background:"rgba(0,0,0,.12)",color:"rgba(0,0,0,.8)",border:"1px solid rgba(0,0,0,.1)",fontFamily:"monospace",marginRight:3}}>{lang==="zh"?"中/EN":"EN/中"}</button>
        {entryMode&&<span style={{fontSize:8,padding:"2px 6px",borderRadius:3,background:entryMode==="quick"?"rgba(245,158,11,.12)":"rgba(139,92,246,.12)",color:entryMode==="quick"?"#f59e0b":"#8b5cf6",fontFamily:"monospace",fontWeight:600,marginRight:2}}>{entryMode==="quick"?(lang==="zh"?"⚡直接":"⚡Quick"):(lang==="zh"?"🐉协作":"🐉Collab")}</span>}
        {[["quick",t.quick,"#ffffff"],["papers",t.papers,"#ec4899"],["research",t.research,"#ef4444"],["inspire",t.inspire,"#f59e0b"],["paper",t.paper,"#8b5cf6"],["polish",t.polish,"#10b981"],["review",t.review,"#f97316"]].filter(([k])=>entryMode==="quick"?k==="quick":entryMode==="collab"?k!=="quick":true).map(([k,l,c])=>
          <button key={k} onClick={()=>setTab(k)} style={{padding:"3px 9px",fontSize:10,fontWeight:tab===k?600:400,borderRadius:4,background:tab===k?c+"15":"transparent",color:tab===k?c:"rgba(0,0,0,.8)",border:"1px solid "+(tab===k?c+"30":"rgba(0,0,0,.04)")}}>{l}</button>)}
      </div>
    </div>}

    {/* Project Bar */}
    <div style={{padding:"4px 14px",borderBottom:"1px solid rgba(0,0,0,.1)",flexShrink:0,background:"rgba(0,0,0,.05)",display:"flex",alignItems:"center",gap:6}}>
      <span style={{fontSize:9,color:"rgba(0,0,0,.8)",fontFamily:"monospace"}}>{t.projLabel}:</span>
      <span style={{fontSize:10,color:projName?"#10b981":"rgba(0,0,0,.85)",fontFamily:"monospace",fontWeight:600,maxWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{projName||"—"}</span>
      {lastSaved&&<span style={{fontSize:8,color:"rgba(0,0,0,.12)",fontFamily:"monospace"}}>{lastSaved}</span>}
      <div style={{marginLeft:"auto",display:"flex",gap:3}}>
        <button onClick={()=>{if(projName){saveProject(projName);}else{setShowSaveInput(true);setSaveName("");}}} style={{padding:"2px 8px",fontSize:9,borderRadius:3,border:"1px solid rgba(16,185,129,.25)",background:"rgba(16,185,129,.08)",color:"#10b981",fontFamily:"monospace",fontWeight:600}}>{t.projSave}</button>
        <button onClick={()=>setShowProj(!showProj)} style={{padding:"2px 8px",fontSize:9,borderRadius:3,border:"1px solid rgba(139,92,246,.25)",background:"rgba(139,92,246,.08)",color:"#8b5cf6",fontFamily:"monospace"}}>{t.projLoad}</button>
        <button onClick={newProject} style={{padding:"2px 8px",fontSize:9,borderRadius:3,border:"1px solid rgba(0,0,0,.1)",background:"rgba(0,0,0,.05)",color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>{t.projNew}</button>
      </div>
      {projMsg&&<span style={{fontSize:9,color:"#10b981",fontFamily:"monospace",animation:"fi .2s",marginLeft:4}}>{projMsg}</span>}
    </div>

    {/* Save name input */}
    {showSaveInput&&<div style={{padding:"4px 14px",borderBottom:"1px solid rgba(0,0,0,.1)",flexShrink:0,background:"rgba(16,185,129,.02)",display:"flex",alignItems:"center",gap:4}}>
      <input value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder={t.projNamePh} autoFocus style={{flex:1,padding:"4px 8px",fontSize:11,maxWidth:200}} onKeyDown={e=>{if(e.key==="Enter"&&saveName.trim()){saveProject(saveName.trim());setShowSaveInput(false);}}}/>
      <button onClick={()=>{if(saveName.trim()){saveProject(saveName.trim());setShowSaveInput(false);}}} style={{padding:"2px 8px",fontSize:9,borderRadius:3,border:"none",background:"#10b981",color:"#fff"}}>OK</button>
      <button onClick={()=>setShowSaveInput(false)} style={{padding:"2px 6px",fontSize:9,borderRadius:3,border:"none",background:"rgba(0,0,0,.1)",color:"rgba(0,0,0,.85)"}}>✕</button>
    </div>}

    {/* Project list dropdown */}
    {showProj&&<div style={{padding:"8px 14px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0,background:"rgba(250,246,240,.97)",maxHeight:220,overflow:"auto"}}>
      {projList.length===0&&<div style={{fontSize:10,color:"rgba(0,0,0,.85)",padding:"6px 0"}}>{t.projEmpty}</div>}
      {projList.filter(k=>k!=="proj:__autosave__").map((key,i)=>{
        const name=key.replace("proj:","");
        const isCurrent=name===projName;
        return <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 10px",marginBottom:3,borderRadius:5,background:isCurrent?"rgba(16,185,129,.06)":"rgba(0,0,0,.03)",border:"1px solid "+(isCurrent?"rgba(16,185,129,.15)":"rgba(0,0,0,.1)")}}>
          <div style={{flex:1,cursor:"pointer",minWidth:0}} onClick={()=>loadProject(key)}>
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              {isCurrent&&<span style={{fontSize:8,padding:"1px 4px",borderRadius:2,background:"#10b98120",color:"#10b981",fontFamily:"monospace"}}>●</span>}
              <span style={{fontSize:11,color:isCurrent?"#10b981":"rgba(0,0,0,.8)",fontWeight:isCurrent?600:400,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</span>
            </div>
          </div>
          <div style={{display:"flex",gap:3,flexShrink:0}}>
            <button onClick={()=>loadProject(key)} style={{padding:"2px 8px",fontSize:9,borderRadius:3,border:"1px solid rgba(139,92,246,.2)",background:"rgba(139,92,246,.06)",color:"#8b5cf6",fontFamily:"monospace"}}>{isCurrent?t.projContinue:t.projLoad}</button>
            {delConfirm===key?<div style={{display:"flex",gap:2}}>
              <button onClick={()=>{deleteProject(key);setDelConfirm(null);}} style={{padding:"2px 6px",fontSize:9,borderRadius:3,border:"none",background:"#ef4444",color:"#fff"}}>✓</button>
              <button onClick={()=>setDelConfirm(null)} style={{padding:"2px 6px",fontSize:9,borderRadius:3,border:"none",background:"rgba(0,0,0,.1)",color:"rgba(0,0,0,.85)"}}>✕</button>
            </div>
            :<button onClick={()=>setDelConfirm(key)} style={{padding:"2px 6px",fontSize:9,borderRadius:3,border:"1px solid rgba(239,68,68,.15)",background:"rgba(239,68,68,.04)",color:"#ef4444",fontFamily:"monospace"}}>{t.projDel}</button>}
          </div>
        </div>;
      })}
    </div>}

    {/* ═══ QUICK MODE ═══ */}
    {tab==="quick"&&<div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {!qBusy&&!qResult?<div style={{flex:1,overflow:"auto",padding:"16px"}}><div style={{maxWidth:560,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:20}}>
          <div style={{fontSize:28,marginBottom:8}}>⚡</div>
          <div style={{fontSize:18,fontWeight:700,background:"linear-gradient(135deg,#f59e0b,#ef4444,#8b5cf6,#10b981)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{t.quickTitle}</div>
          <div style={{fontSize:11,color:"rgba(0,0,0,.85)",marginTop:4}}>{t.quickDesc}</div>
        </div>

        <div className="lb">{t.quickTopic}</div>
        <textarea value={qTopic} onChange={e=>setQTopic(e.target.value)} placeholder={t.quickTopicPh} rows={3} style={{marginBottom:14,resize:"vertical",fontSize:13,lineHeight:1.6}}/>

        <div className="lb">{t.domain}</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:16}}>
          {DOMAINS.map(d=><button key={d.id} onClick={()=>setQDom(d.id)} style={{padding:"4px 8px",fontSize:10,borderRadius:4,background:qDom===d.id?d.color+"15":"rgba(0,0,0,.03)",color:qDom===d.id?d.color:"rgba(0,0,0,.8)",border:"1px solid "+(qDom===d.id?d.color+"30":"rgba(0,0,0,.1)"),fontWeight:qDom===d.id?600:400,whiteSpace:"nowrap"}}><span style={{marginRight:2}}>{d.icon}</span>{d.label}</button>)}
        </div>

        <button onClick={runQuick} disabled={!qTopic.trim()||!qDom} style={{width:"100%",padding:"14px",fontSize:14,fontWeight:700,borderRadius:8,border:"none",background:qTopic.trim()&&qDom?"linear-gradient(135deg,#f59e0b,#ef4444,#8b5cf6,#10b981)":"rgba(0,0,0,.1)",color:qTopic.trim()&&qDom?"#fff":"rgba(0,0,0,.85)"}}>{t.quickStart}</button>

        <div style={{marginTop:20,padding:"12px",borderRadius:8,background:"rgba(0,0,0,.05)",border:"1px solid rgba(0,0,0,.1)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:0}}>
            {[{icon:"🔬",c:"#ef4444"},{icon:"💡",c:"#f59e0b"},{icon:"📄",c:"#8b5cf6"},{icon:"🔧",c:"#10b981"},{icon:"⭐",c:"#f97316"},{icon:"✅",c:"#10b981"},{icon:"📥",c:"#3b82f6"}].map((s,i)=><div key={i} style={{display:"flex",alignItems:"center"}}>
              <div style={{width:22,height:22,borderRadius:11,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,background:s.c+"10",border:"1.5px solid "+s.c+"30"}}>{s.icon}</div>
              {i<6&&<div style={{width:16,height:1.5,background:"rgba(0,0,0,.12)"}}/>}
            </div>)}
          </div>
        </div>
      </div></div>

      :<div style={{flex:1,display:"flex",flexDirection:"column"}}>
        <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <div style={{fontSize:14,fontWeight:700,background:"linear-gradient(135deg,#f59e0b,#ef4444,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{t.quickTitle}</div>
            <div style={{display:"flex",gap:4}}>
              {qBusy&&<button onClick={()=>{qAbort.current?.abort();setQBusy(false);setQStep(0);}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444"}}>{t.stop}</button>}
              {qResult&&<button onClick={()=>{setQResult(null);setQLogs([]);setQStep(0);}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"1px solid rgba(0,0,0,.1)",background:"transparent",color:"rgba(0,0,0,.85)"}}>{t.reset}</button>}
            </div>
          </div>
          {/* Step progress indicator */}
          <div style={{display:"flex",alignItems:"center",gap:0}}>
            {[
              {n:1,icon:"🔬",label:lang==="zh"?"研究":"Research",color:"#ef4444"},
              {n:2,icon:"💡",label:lang==="zh"?"灵感":"Inspire",color:"#f59e0b"},
              {n:3,icon:"📄",label:lang==="zh"?"论文":"Paper",color:"#8b5cf6"},
              {n:4,icon:"🔧",label:lang==="zh"?"打磨":"Polish",color:"#10b981"},
              {n:5,icon:"⭐",label:lang==="zh"?"审稿":"Review",color:"#f97316"},
              {n:6,icon:"✅",label:lang==="zh"?"完成":"Done",color:"#10b981"},
              {n:7,icon:"📥",label:lang==="zh"?"输出":"Output",color:"#3b82f6"},
            ].map((s,i)=>{
              // When qResult exists (flow complete), show all steps as done — no animation
              const allDone=!!qResult;
              const done=allDone||qStep>s.n||(qStep>=7&&s.n<=7);
              const active=!allDone&&qStep===s.n&&qStep>0&&qStep<7;
              const pending=!allDone&&qStep<s.n&&qStep<7;
              return <div key={s.n} style={{display:"flex",alignItems:"center",flex:1}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,minWidth:36}}>
                  <div style={{width:28,height:28,borderRadius:14,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,
                    background:done?"rgba(16,185,129,.15)":active?s.color+"20":"rgba(0,0,0,.04)",
                    border:"2px solid "+(done?"#10b981":active?s.color:"rgba(0,0,0,.12)"),
                    animation:active?"pulse 1.5s infinite":"none",
                    transition:"all .3s"}}>
                    {done?"✓":s.icon}
                  </div>
                  <div style={{fontSize:8,color:done?"#10b981":active?s.color:"rgba(0,0,0,.12)",fontFamily:"monospace",fontWeight:active?700:400,whiteSpace:"nowrap"}}>{s.label}</div>
                </div>
                {i<6&&<div style={{flex:1,height:2,margin:"0 2px",marginBottom:14,borderRadius:1,background:done?"#10b98140":"rgba(0,0,0,.1)",transition:"background .3s"}}/>}
              </div>;
            })}
          </div>
        </div>
        <div ref={qRef} style={{flex:1,overflow:"auto",padding:"10px 16px",minHeight:0,maxHeight:"calc(100vh - 200px)",WebkitOverflowScrolling:"touch"}}>
          {qLogs.map((l,i)=><div key={i} style={{fontFamily:"monospace",fontSize:11,lineHeight:1.8,animation:"fi .1s",color:l.c||"rgba(0,0,0,.85)"}}>{l.m}</div>)}

          {qResult&&<div style={{marginTop:12,animation:"fi .3s"}}>
            {/* Output section separator */}
            <div style={{display:"flex",alignItems:"center",gap:8,margin:"12px 0 16px"}}>
              <div style={{flex:1,height:1,background:"rgba(0,0,0,.1)"}}/>
              <span style={{fontSize:11,fontWeight:700,color:"#10b981",letterSpacing:2,fontFamily:"monospace"}}>{lang==="zh"?"输出结果":"OUTPUT"}</span>
              <div style={{flex:1,height:1,background:"rgba(0,0,0,.1)"}}/>
            </div>

            {/* ── Inline Paper Output (论文输出) ── */}
            {(()=>{try{const p=qResult.polished||qResult.paper;if(!p||!p.title)return <div style={{padding:16,textAlign:"center",color:"rgba(0,0,0,.4)",fontSize:12}}>{lang==="zh"?"论文数据解析中...":"Parsing paper data..."}</div>;return <div style={{marginBottom:16,borderRadius:10,border:"1px solid rgba(139,92,246,.15)",overflow:"hidden"}}>
              {/* Paper header */}
              <div style={{padding:"14px 16px",background:"rgba(139,92,246,.04)",borderBottom:"1px solid rgba(139,92,246,.1)"}}>
                <div style={{fontSize:10,fontWeight:600,color:"#8b5cf6",fontFamily:"monospace",marginBottom:4}}>📄 {lang==="zh"?"论文输出":"PAPER OUTPUT"}{qResult.polished?(" · "+(lang==="zh"?"已打磨":"Polished")):""}</div>
                <div style={{fontSize:15,fontWeight:700,color:"#111",lineHeight:1.4}}>{p.title}</div>
                <div style={{fontSize:10,color:"rgba(0,0,0,.5)",marginTop:4,fontFamily:"monospace"}}>{(p.secs||[]).length} {lang==="zh"?"节":"sections"} · {(p.secs||[]).reduce((s,x)=>s+(x.content||"").split(/\s+/).length,0)} {lang==="zh"?"词":"words"}</div>
              </div>
              {/* Abstract */}
              {p.abs&&<div style={{padding:"12px 16px",borderBottom:"1px solid rgba(0,0,0,.06)",background:"rgba(139,92,246,.02)"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#8b5cf6",marginBottom:4}}>Abstract</div>
                <div style={{fontSize:11,color:"#333",lineHeight:1.7}}>{p.abs}</div>
                {p.kw&&p.kw.length>0&&<div style={{marginTop:6,fontSize:9,color:"rgba(0,0,0,.5)"}}><b>Keywords:</b> {p.kw.join("; ")}</div>}
              </div>}
              {/* Sections */}
              <div style={{padding:"0 16px"}}>
                {(p.secs||[]).map((sec,si)=><div key={si} style={{padding:"10px 0",borderBottom:si<(p.secs||[]).length-1?"1px solid rgba(0,0,0,.05)":"none"}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#333",marginBottom:4}}>{sec.num}. {sec.title}</div>
                  <div style={{fontSize:10.5,color:"#444",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{(sec.content||"").substring(0,600)}{(sec.content||"").length>600?"...":""}</div>
                </div>)}
              </div>
              {/* References */}
              {p.refs&&p.refs.length>0&&<div style={{padding:"10px 16px",borderTop:"1px solid rgba(0,0,0,.06)",background:"rgba(0,0,0,.02)"}}>
                <div style={{fontSize:10,fontWeight:700,color:"rgba(0,0,0,.5)",marginBottom:4}}>References ({p.refs.length})</div>
                <div style={{fontSize:9,color:"rgba(0,0,0,.5)",lineHeight:1.6,maxHeight:80,overflow:"auto"}}>{p.refs.slice(0,8).map((r,ri)=><div key={ri}>{r}</div>)}{p.refs.length>8&&<div>... +{p.refs.length-8} more</div>}</div>
              </div>}
            </div>;}catch(e){return <div style={{padding:16,color:"#ef4444",fontSize:11}}>Error: {e.message}</div>;}})()}

            {/* Download buttons */}
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <button onClick={()=>{try{const p=qResult.polished||qResult.paper;if(!p){setQLogs(prev=>[...prev,{m:"✗ No paper data",c:"#ef4444"}]);return;}const md=mkMd(p);if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(md).then(()=>setQLogs(prev=>[...prev,{m:"📋 "+(lang==="zh"?"已复制到剪贴板！可直接粘贴到Word":"Copied to clipboard! Paste into Word"),c:"#10b981"}])).catch(()=>setQLogs(prev=>[...prev,{m:"⚠ "+(lang==="zh"?"剪贴板不可用·请展开下方原文手动复制":"Clipboard blocked — expand raw text below to copy"),c:"#f59e0b"}]));}else{setQLogs(prev=>[...prev,{m:"⚠ "+(lang==="zh"?"剪贴板不可用·请展开下方原文手动复制":"Clipboard unavailable — expand raw text below"),c:"#f59e0b"}]);}}catch(e){setQLogs(prev=>[...prev,{m:"✗ "+e.message,c:"#ef4444"}]);}}} style={{flex:1,padding:"14px",fontSize:13,fontWeight:700,borderRadius:8,border:"none",background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",color:"#fff"}}>📋 {lang==="zh"?"复制全文（Markdown）":"Copy Full Text (MD)"}</button>
            </div>
            <div style={{display:"flex",gap:6,marginBottom:8}}>
              <button onClick={()=>{try{const p=qResult.polished||qResult.paper;if(!p)return;dl(wordHtml(p),"SDE_"+safeName(p)+".doc","application/msword");setQLogs(prev=>[...prev,{m:"⬇ "+(lang==="zh"?"Word下载已触发":"Word download triggered"),c:"#3b82f6"}]);}catch(e){setQLogs(prev=>[...prev,{m:"✗ Word: "+e.message,c:"#ef4444"}]);}}} style={{flex:1,padding:"10px",fontSize:11,fontWeight:600,borderRadius:6,border:"1px solid #3b82f650",background:"#3b82f610",color:"#3b82f6"}}>⬇ Word</button>
              <button onClick={()=>{try{const p=qResult.polished||qResult.paper;if(!p)return;dl(mkMd(p),"SDE_"+safeName(p)+".md");setQLogs(prev=>[...prev,{m:"⬇ "+(lang==="zh"?"Markdown下载已触发":"MD download triggered"),c:"#10b981"}]);}catch(e){setQLogs(prev=>[...prev,{m:"✗ MD: "+e.message,c:"#ef4444"}]);}}} style={{flex:1,padding:"10px",fontSize:11,fontWeight:600,borderRadius:6,border:"1px solid #10b98150",background:"#10b98110",color:"#10b981"}}>⬇ Markdown</button>
            </div>
            {/* Raw Markdown fallback — expandable for manual copy */}
            <details style={{marginBottom:16,borderRadius:8,border:"1px solid rgba(0,0,0,.1)",overflow:"hidden"}}>
              <summary style={{padding:"10px 14px",fontSize:11,fontWeight:600,color:"rgba(0,0,0,.5)",cursor:"pointer",background:"rgba(0,0,0,.02)"}}>{lang==="zh"?"📝 展开原文（可手动全选复制）":"📝 Expand raw text (select all & copy)"}</summary>
              <pre style={{padding:"12px 14px",fontSize:10,lineHeight:1.6,color:"#333",whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:400,overflow:"auto",background:"#fff",margin:0,fontFamily:"'Courier New',monospace"}}>{(()=>{try{const p=qResult.polished||qResult.paper;return p?mkMd(p):"No data";}catch{return "Error generating text";}})()}</pre>
            </details>

            {/* Score summary */}
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <div style={{flex:1,padding:"10px",borderRadius:8,background:"rgba(249,115,22,.06)",border:"1px solid rgba(249,115,22,.15)",textAlign:"center"}}>
                <div style={{fontSize:9,color:"#f97316",fontFamily:"monospace"}}>E1</div>
                <div style={{fontSize:22,fontWeight:800,color:qResult.review.e1.score>=80?"#10b981":qResult.review.e1.score>=60?"#f59e0b":"#ef4444"}}>{qResult.review.e1.score}</div>
              </div>
              <div style={{flex:1,padding:"10px",borderRadius:8,background:"rgba(139,92,246,.06)",border:"1px solid rgba(139,92,246,.15)",textAlign:"center"}}>
                <div style={{fontSize:9,color:"#8b5cf6",fontFamily:"monospace"}}>E2</div>
                <div style={{fontSize:22,fontWeight:800,color:qResult.review.e2.score>=80?"#10b981":qResult.review.e2.score>=60?"#f59e0b":"#ef4444"}}>{qResult.review.e2.score}</div>
              </div>
              <div style={{flex:1,padding:"10px",borderRadius:8,background:"rgba(245,158,11,.06)",border:"1px solid rgba(245,158,11,.15)",textAlign:"center"}}>
                <div style={{fontSize:9,color:"#f59e0b",fontFamily:"monospace"}}>E3</div>
                <div style={{fontSize:22,fontWeight:800,color:qResult.review.e3.score>=80?"#10b981":qResult.review.e3.score>=60?"#f59e0b":"#ef4444"}}>{qResult.review.e3.score}</div>
              </div>
              <div style={{flex:1,padding:"10px",borderRadius:8,background:"rgba(0,0,0,.1)",border:"1px solid rgba(0,0,0,.12)",textAlign:"center"}}>
                <div style={{fontSize:9,color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>{t.reviewAvg}</div>
                <div style={{fontSize:22,fontWeight:800,color:qResult.review.avg>=80?"#10b981":qResult.review.avg>=60?"#f59e0b":"#ef4444"}}>{qResult.review.avg}</div>
              </div>
            </div>
            <div style={{textAlign:"center",marginBottom:12,fontSize:13,fontWeight:700,color:qResult.review.avg>=75?"#10b981":"#f59e0b"}}>{qResult.review.verdict}</div>

            {/* View detail buttons */}
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              <button onClick={()=>{setPStep("read");setTab("paper");}} style={{flex:1,padding:"8px",fontSize:11,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",color:"#fff"}}>📄 {lang==="zh"?"查看论文":"View Paper"}</button>
              <button onClick={()=>{setPolStep("result");setTab("polish");}} style={{flex:1,padding:"8px",fontSize:11,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#10b981,#06b6d4)",color:"#fff"}}>🔧 {lang==="zh"?"查看打磨":"View Polished"}</button>
              <button onClick={()=>{setRvStep("scoring");setTab("review");}} style={{flex:1,padding:"8px",fontSize:11,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#f97316,#ef4444)",color:"#fff"}}>⭐ {lang==="zh"?"查看评分":"View Review"}</button>
            </div>
          </div>}
        </div>
      </div>}
    </div>}

    {/* ═══ PAPERS INPUT ═══ */}
    {tab==="papers"&&<div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div><div style={{fontSize:14,fontWeight:700}}>{t.papersTitle}</div><div style={{fontSize:10,color:"rgba(0,0,0,.85)"}}>{t.papersDesc}</div></div>
          <div style={{display:"flex",gap:4}}>
            {paBusy?<button onClick={()=>{paAbort.current?.abort();setPaBusy(false);setPaPhase("");}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444",whiteSpace:"nowrap"}}>{t.stop}</button>
            :paResult?<button onClick={()=>{setPaLogs([]);setPaResult(null);}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"1px solid rgba(0,0,0,.1)",background:"transparent",color:"rgba(0,0,0,.85)"}}>{t.reset}</button>
            :(()=>{
              const parsing=inputPapers.filter(p=>p.meta?.level==="unknown"||(p.content||"").startsWith("[Reading file...")).length;
              const ready=inputPapers.filter(p=>p.meta?.level!=="unknown"&&!(p.content||"").startsWith("[Reading file...")).length;
              const disabled=inputPapers.length===0||parsing>0;
              const btnText=parsing>0
                ?(lang==="zh"?`⏳ 解析中 ${ready}/${inputPapers.length}`:`⏳ Parsing ${ready}/${inputPapers.length}`)
                :t.startAnalysis;
              return <button onClick={analyzePapers} disabled={disabled} style={{padding:"6px 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:disabled?"rgba(0,0,0,.08)":"linear-gradient(135deg,#ec4899,#8b5cf6)",color:disabled?"rgba(0,0,0,.35)":"#fff",cursor:disabled?"not-allowed":"pointer"}}>{btnText}</button>;
            })()}
          </div>
        </div>
        {paPhase&&<div style={{marginTop:4,fontSize:10,color:"#ec4899",fontFamily:"monospace",animation:"pulse 1.5s infinite"}}>▸ {paPhase}</div>}
      </div>
      <div ref={paRef} style={{flex:1,overflow:"auto",padding:"10px 16px"}}>
        {/* Upload + paste area */}
        {!paBusy&&!paResult&&<div>
          {/* Batch file upload */}
          <div style={{display:"flex",gap:6,marginBottom:12}}>
            <div onClick={()=>paFileRef.current?.click()} onDragOver={e=>{e.preventDefault();e.stopPropagation();e.currentTarget.style.borderColor="rgba(236,72,153,.6)";e.currentTarget.style.background="rgba(236,72,153,.08)";}} onDragEnter={e=>{e.preventDefault();e.stopPropagation();}} onDragLeave={e=>{e.preventDefault();e.stopPropagation();e.currentTarget.style.borderColor="rgba(236,72,153,.25)";e.currentTarget.style.background="rgba(236,72,153,.03)";}} onDrop={e=>{e.preventDefault();e.stopPropagation();e.currentTarget.style.borderColor="rgba(236,72,153,.25)";e.currentTarget.style.background="rgba(236,72,153,.03)";if(e.dataTransfer.files&&e.dataTransfer.files.length>0)handleFileUpload(e.dataTransfer.files);}} style={{flex:1,padding:"14px",borderRadius:8,border:"2px dashed rgba(236,72,153,.25)",background:"rgba(236,72,153,.03)",textAlign:"center",cursor:"pointer",transition:"all .15s"}}>
              <div style={{fontSize:13,fontWeight:600,color:"#ec4899",marginBottom:2}}>{t.uploadFiles}</div>
              <div style={{fontSize:10,color:"rgba(0,0,0,.8)"}}>{lang==="zh"?"最多 20 篇 · 按住 Ctrl 或 Shift 多选 · 或拖拽多个文件到此":"Max 20 · Hold Ctrl/Shift to multi-select · Or drag & drop files"}</div>
            </div>
            <input ref={paFileRef} type="file" multiple accept=".pdf,.docx,.doc,.txt,.md,.tex" style={{display:"none"}} onChange={e=>{if(e.target.files&&e.target.files.length>0)handleFileUpload(e.target.files);}}/>
          </div>

          {/* Loaded files list */}
          {inputPapers.length>0&&<div style={{marginBottom:12}}>
            <div style={{fontSize:10,color:"rgba(0,0,0,.85)",fontFamily:"monospace",marginBottom:6}}>{inputPapers.length} {t.papersLoaded} · {inputPapers.filter(p=>p.content&&p.content.trim().length>20&&!p.content.startsWith("[")).length} {lang==="zh"?"篇可用":"valid"}</div>
            {inputPapers.map((p,i)=><div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 10px",marginBottom:3,borderRadius:5,background:"rgba(236,72,153,.04)",border:"1px solid rgba(236,72,153,.08)"}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0}}>
                <span style={{fontSize:10,color:"#ec4899",fontFamily:"monospace",flexShrink:0}}>{i+1}.</span>
                <span style={{fontSize:11,color:"rgba(0,0,0,.8)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</span>
                <span style={{fontSize:9,color:"rgba(0,0,0,.8)",fontFamily:"monospace",flexShrink:0}}>~{p.content.split(/\s+/).length}w</span>
              </div>
              <button onClick={()=>setInputPapers(prev=>prev.filter((_,j)=>j!==i))} style={{fontSize:10,color:"rgba(0,0,0,.85)",background:"none",border:"none",cursor:"pointer",flexShrink:0,marginLeft:6}}>{t.removePaper}</button>
            </div>)}
          </div>}

          {/* Paste area */}
          <div style={{marginBottom:8}}>
            <div style={{fontSize:10,color:"rgba(0,0,0,.8)",marginBottom:4}}>{t.pasteArea}</div>
            <textarea value={paText} onChange={e=>setPaText(e.target.value)} placeholder="..." rows={3} style={{resize:"vertical",fontSize:11,lineHeight:1.5}}/>
            {paText.trim()&&<button onClick={addPastedText} style={{marginTop:4,padding:"5px 12px",fontSize:10,fontWeight:600,borderRadius:5,border:"none",background:"rgba(236,72,153,.15)",color:"#ec4899"}}>+ {lang==="zh"?"添加":"Add"}</button>}
          </div>
        </div>}

        {/* Analysis logs */}
        {paLogs.map((m,i)=>{
          if(m.role==="sys")return <div key={i} style={{padding:"4px 0",fontFamily:"monospace",fontSize:11,animation:"fi .15s",color:m.text.includes("✅")||m.text.includes("✓")?"#10b981":m.text.includes("✗")||m.text.includes("⏹")?"#ef4444":m.text.includes("──")?"rgba(0,0,0,.1)":"#ec4899"}}>{m.text}</div>;
          const R=ROLES[m.role];
          const dimLabel=m.role==="E1"?t.papersLandscape:m.role==="E2"?t.papersGaps:t.papersNewQ;
          return <div key={i} style={{margin:"6px 0",padding:"10px 12px",borderRadius:8,animation:"fi .2s",background:R.color+"08",border:"1px solid "+R.color+"18",borderLeft:"3px solid "+R.color+"40"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}><span style={{color:R.color,fontSize:12}}>{R.icon}</span><span style={{color:R.color,fontSize:11,fontWeight:600,fontFamily:"monospace"}}>{dimLabel}</span></div><Cp text={m.text}/></div>
            <div style={{fontSize:12,lineHeight:1.75,color:"rgba(0,0,0,.8)",whiteSpace:"pre-wrap"}}>{m.text}</div></div>;
        })}

        {/* Results: new questions */}
        {paResult&&<div style={{marginTop:12,animation:"fi .3s"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#ec4899",marginBottom:4}}>{t.papersNewDirs}</div>
          <div style={{fontSize:10,color:"rgba(0,0,0,.85)",marginBottom:12}}>{lang==="zh"?"点击按钮直接进入前期研究，无需复制":"Click to auto-enter Research module, no copy needed"}</div>
          {paResult.questions.map((q,i)=><div key={i} style={{padding:"12px 14px",marginBottom:8,borderRadius:8,background:"rgba(236,72,153,.04)",border:"1px solid rgba(236,72,153,.15)"}}>
            <div style={{fontSize:13,fontWeight:700,color:"rgba(0,0,0,.85)",marginBottom:4}}>{lang==="zh"?"新问题":"Q"}{i+1}: {q.question}</div>
            {q.why&&<div style={{fontSize:11,color:"rgba(0,0,0,.85)",marginBottom:6,lineHeight:1.6}}>{q.why}</div>}
            {q.from_papers&&<div style={{fontSize:9,color:"rgba(0,0,0,.8)",fontFamily:"monospace",marginBottom:6}}>{q.from_papers}</div>}
            <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
              <button onClick={()=>paToResearch(q)} style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"none",background:"linear-gradient(135deg,#ef4444,#8b5cf6)",color:"#fff"}}>{t.papersToRes}</button>
              <button onClick={()=>paToInspire(q)} style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"none",background:"linear-gradient(135deg,#f59e0b,#ef4444)",color:"#fff"}}>{t.papersToInsp}</button>
            </div>
          </div>)}
          <div style={{marginTop:8}}><Cp text={`# ${t.papersTitle}\n\n## ${t.papersLandscape}\n${paResult.landscape}\n\n## ${t.papersGaps}\n${paResult.gaps}\n\n## ${t.papersNewQ}\n${paResult.newQ}\n\n## ${t.papersNewDirs}\n${paResult.questions.map((q,i)=>`${i+1}. ${q.question}\n   ${q.why||""}`).join("\n\n")}`} label={lang==="zh"?"复制分析报告":"Copy Report"}/></div>
        </div>}

        {paLogs.length===0&&!paResult&&inputPapers.length===0&&<div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",paddingTop:40,color:"rgba(0,0,0,.12)"}}>
          <div style={{fontSize:32}}>📚</div><div style={{fontSize:12,marginTop:6}}>{t.papersWait}</div><div style={{fontSize:10,marginTop:4}}>{t.papersFlow}</div>
        </div>}
      </div>
    </div>}

    {/* ═══ RESEARCH ═══ */}
    {tab==="research"&&<div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
        <div style={{display:"flex",gap:6}}>
          <textarea value={rQ} onChange={e=>setRQ(e.target.value)} disabled={rBusy} placeholder={t.resPh} style={{flex:1,height:46,resize:"none",lineHeight:1.5}}/>
          {rBusy?<button onClick={()=>{rAbort.current?.abort();setRBusy(false);setRPhase("");}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444",whiteSpace:"nowrap"}}>{t.stop}</button>
          :rReport?<button onClick={()=>{setRLogs([]);setRReport(null);}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"1px solid rgba(0,0,0,.1)",background:"transparent",color:"rgba(0,0,0,.85)",whiteSpace:"nowrap"}}>{t.reset}</button>
          :<button onClick={runResearch} disabled={!rQ.trim()} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:rQ.trim()?"linear-gradient(135deg,#ef4444,#8b5cf6)":"rgba(0,0,0,.04)",color:rQ.trim()?"#fff":"rgba(0,0,0,.1)",whiteSpace:"nowrap"}}>{t.startRes}</button>}
        </div>
        {rPhase&&<div style={{marginTop:5,fontSize:10,color:"#ef4444",fontFamily:"monospace",animation:"pulse 1.5s infinite"}}>▸ {rPhase}</div>}
      </div>
      <div ref={rRef} style={{flex:1,overflow:"auto",padding:"10px 16px"}}>
        {rLogs.length===0&&!rReport&&<div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,color:"rgba(0,0,0,.12)"}}>
          <div style={{fontSize:32}}>🔬</div><div style={{fontSize:12}}>{t.resWait}</div><div style={{fontSize:10}}>{t.resFlow}</div>
          <div style={{display:"flex",gap:16,marginTop:8}}>
            {[{l:"S·结构",c:"#3b82f6",i:"▣"},{l:"D·差异",c:"#8b5cf6",i:"◇"},{l:"E·纠缠",c:"#f59e0b",i:"★"}].map((d,i)=><div key={i} style={{textAlign:"center"}}>
              <div style={{fontSize:20,color:d.c}}>{d.i}</div><div style={{fontSize:9,color:d.c,fontFamily:"monospace"}}>{d.l}</div></div>)}
          </div></div>}

        {rLogs.map((m,i)=>{
          if(m.role==="sys")return <div key={i} style={{padding:"4px 0",...logStyle,animation:"fi .15s",color:logColor(m.text)}}>{m.text}</div>;
          const R=ROLES[m.role];const dimLabel=m.role==="E1"?t.resDimS:m.role==="E2"?t.resDimD:t.resDimE;
          return <div key={i} style={{margin:"6px 0",padding:"10px 12px",borderRadius:8,animation:"fi .2s",background:R.color+"08",border:"1px solid "+R.color+"18",borderLeft:"3px solid "+R.color+"40"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}><span style={{color:R.color,fontSize:12}}>{R.icon}</span><span style={{color:R.color,fontSize:11,fontWeight:600,fontFamily:"monospace"}}>{dimLabel}</span></div><Cp text={m.text}/></div>
            <div style={{fontSize:12,lineHeight:1.75,color:"rgba(0,0,0,.8)",whiteSpace:"pre-wrap"}}>{m.text}</div></div>;})}

        {rReport&&<div style={{marginTop:12,animation:"fi .3s"}}>
          <div style={{padding:"14px",borderRadius:8,background:"rgba(139,92,246,.04)",border:"1px solid rgba(139,92,246,.15)",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:"#8b5cf6",marginBottom:8}}>{t.resSynth}</div>
            <div style={{fontSize:12,lineHeight:1.8,color:"rgba(0,0,0,.85)",whiteSpace:"pre-wrap"}}>{rReport.synthesis}</div>
          </div>

          {rReport.newQuestions&&rReport.newQuestions.length>0&&<div style={{marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:700,color:"#f59e0b",marginBottom:4}}>{t.resDirs}</div>
            <div style={{fontSize:10,color:"rgba(0,0,0,.85)",marginBottom:8}}>{lang==="zh"?"点击直接进入下一步研究":"Click to auto-enter next step"}</div>
            {rReport.newQuestions.map((q,i)=><div key={i} style={{padding:"10px 12px",marginBottom:6,borderRadius:7,background:"rgba(245,158,11,.04)",border:"1px solid rgba(245,158,11,.15)"}}>
              <div style={{fontSize:12,fontWeight:600,color:"rgba(0,0,0,.8)",marginBottom:3}}>{lang==="zh"?"新问题":"Q"}{i+1}: {q.question}</div>
              {q.why&&<div style={{fontSize:11,color:"rgba(0,0,0,.8)",marginBottom:6,lineHeight:1.5}}>{q.why}</div>}
              <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                {q.sde_dim&&<span style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:"#8b5cf610",color:"#8b5cf6",fontFamily:"monospace"}}>{q.sde_dim}</span>}
                <div style={{marginLeft:"auto",display:"flex",gap:4}}>
                  <button onClick={()=>{setRQ(q.question+(q.why?"\n"+q.why:""));setRLogs([]);setRReport(null);}} style={{padding:"4px 12px",fontSize:10,fontWeight:600,borderRadius:4,border:"none",background:"linear-gradient(135deg,#ef4444,#8b5cf6)",color:"#fff"}}>{lang==="zh"?"→ 深入研究":"→ Deep Research"}</button>
                  <button onClick={()=>rToInspire(q.question+(q.why?"\n"+q.why:""))} style={{padding:"4px 12px",fontSize:10,fontWeight:600,borderRadius:4,border:"none",background:"linear-gradient(135deg,#f59e0b,#ef4444)",color:"#fff"}}>{t.resToInspire}</button>
                </div>
              </div>
            </div>)}
          </div>}

          <div style={{display:"flex",gap:6}}>
            <button onClick={rToPaper} style={{flex:1,padding:"9px",fontSize:12,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",color:"#fff"}}>{t.resToPaper}</button>
          </div>
          <div style={{marginTop:8}}><Cp text={`# SDE Research: ${rReport.question}\n\n## S-Dimension\n${rReport.s}\n\n## D-Dimension\n${rReport.d}\n\n## E-Dimension\n${rReport.e}\n\n## Synthesis\n${rReport.synthesis}`} label={lang==="zh"?"复制研究报告":"Copy Report"}/></div>
        </div>}
      </div>
    </div>}

    {/* ═══ INSPIRE ═══ */}
    {tab==="inspire"&&<div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
        <div style={{display:"flex",gap:6}}>
          <textarea value={area} onChange={e=>setArea(e.target.value)} disabled={iBusy} placeholder={t.areaPlaceholder} style={{flex:1,height:46,resize:"none",lineHeight:1.5}}/>
          {iBusy?<button onClick={()=>{iAbort.current?.abort();setIBusy(false);setIPhase("");}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444",whiteSpace:"nowrap"}}>{t.stop}</button>
          :synth?<button onClick={()=>{setMsgs([]);setSynth(null);}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"1px solid rgba(0,0,0,.1)",background:"transparent",color:"rgba(0,0,0,.85)",whiteSpace:"nowrap"}}>{t.reset}</button>
          :<button onClick={inspire} disabled={!area.trim()} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:area.trim()?"linear-gradient(135deg,#f59e0b,#ef4444)":"rgba(0,0,0,.04)",color:area.trim()?"#fff":"rgba(0,0,0,.1)",whiteSpace:"nowrap"}}>{t.startGCG}</button>}
        </div>
        {iPhase&&<div style={{marginTop:5,fontSize:10,color:"#f59e0b",fontFamily:"monospace",animation:"pulse 1.5s infinite"}}>▸ {iPhase}</div>}
      </div>
      <div ref={iRef} style={{flex:1,overflow:"auto",padding:"10px 16px"}}>
        {msgs.length===0&&!synth&&<div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10,color:"rgba(0,0,0,.12)"}}><div style={{fontSize:32}}>💡</div><div style={{fontSize:12}}>{t.waitInspire}</div><div style={{fontSize:10}}>{t.waitFlow}</div></div>}
        {msgs.map((m,i)=>{if(m.role==="sys")return <div key={i} style={{padding:"4px 0",...logStyle,animation:"fi .15s",color:logColor(m.text)}}>{m.text}</div>;
          const R=ROLES[m.role];return <div key={i} style={{margin:"6px 0",padding:"10px 12px",borderRadius:8,animation:"fi .2s",background:R.color+"08",border:"1px solid "+R.color+"18",borderLeft:"3px solid "+R.color+"40"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}><div style={{display:"flex",alignItems:"center",gap:5}}><span style={{color:R.color,fontSize:12}}>{R.icon}</span><span style={{color:R.color,fontSize:11,fontWeight:600,fontFamily:"monospace"}}>{R.label}</span><span style={{fontSize:9,color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>R{m.round}</span></div><Cp text={m.text}/></div>
            <div style={{fontSize:12,lineHeight:1.75,color:"rgba(0,0,0,.8)",whiteSpace:"pre-wrap"}}>{m.text}</div></div>;})}
        {synth&&<div style={{marginTop:12,animation:"fi .3s"}}><div style={{fontSize:13,fontWeight:700,color:"#f59e0b",marginBottom:10}}>{t.emergTitle}</div>
          {[["new_problems",t.newProblems,"#ef4444"],["new_values",t.newValues,"#10b981"],["new_structures",t.newStructures,"#3b82f6"]].map(([k,l,c])=>synth[k]?.length>0&&<div key={k} style={{marginBottom:12}}><div style={{fontSize:10,fontWeight:600,color:c,marginBottom:5,fontFamily:"monospace"}}>{l}</div>
            {synth[k].map((v,i)=><div key={i} style={{padding:"7px 11px",marginBottom:3,borderRadius:5,background:c+"08",border:"1px solid "+c+"15",fontSize:12,color:"rgba(0,0,0,.8)",lineHeight:1.6}}>{v}</div>)}</div>)}
          {synth.directions?.length>0&&<div style={{marginBottom:12}}><div style={{fontSize:11,fontWeight:700,color:"#8b5cf6",marginBottom:10,fontFamily:"monospace"}}>{t.paperDirs}</div>
            {synth.directions.map((d,i)=><div key={i} style={{padding:"12px 14px",marginBottom:8,borderRadius:8,background:"rgba(139,92,246,.04)",border:"1px solid rgba(139,92,246,.15)"}}>
              <div style={{fontSize:13,fontWeight:700,color:"rgba(0,0,0,.85)",marginBottom:6}}>{i+1}. {d.title}</div>
              {d.innovations&&d.innovations.length>0&&<div style={{marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:600,color:"#f59e0b",marginBottom:4,fontFamily:"monospace"}}>{t.dirInnov}</div>
                {d.innovations.map((inn,j)=><div key={j} style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:3}}>
                  <span style={{color:"#f59e0b",fontSize:10,marginTop:2}}>▸</span>
                  <span style={{fontSize:11,color:"rgba(0,0,0,.8)",lineHeight:1.5}}>{inn}</span>
                </div>)}
              </div>}
              {d.abstract&&<div style={{marginBottom:8}}>
                <div style={{fontSize:10,fontWeight:600,color:"#06b6d4",marginBottom:4,fontFamily:"monospace"}}>{t.dirAbstract}</div>
                <div style={{fontSize:11,color:"rgba(0,0,0,.85)",lineHeight:1.6,padding:"8px 10px",borderRadius:5,background:"rgba(0,0,0,.05)",borderLeft:"2px solid rgba(6,182,212,.25)"}}>{d.abstract}</div>
              </div>}
              <div style={{display:"flex",justifyContent:"flex-end"}}>
                <button onClick={()=>toPaper(d)} style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"none",background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",color:"#fff"}}>{t.genPaper}</button>
              </div>
            </div>)}</div>}
        </div>}
      </div>
    </div>}

    {/* ═══ PAPER ═══ */}
    {tab==="paper"&&pStep==="cfg"&&<div style={{flex:1,overflow:"auto",display:"flex",justifyContent:"center",padding:"16px"}}><div style={{width:"100%",maxWidth:520}}>
      <div style={{fontSize:16,fontWeight:700,marginBottom:12}}>{t.paperTitle}</div>
      {(topic||pTitle)&&<div style={{marginBottom:12,padding:"6px 10px",borderRadius:5,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.12)",fontSize:11,color:"#10b981"}}>{t.importedHint}</div>}
      <div className="lb">{t.domain}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10}}>{DOMAINS.map(d=><button key={d.id} onClick={()=>{setDom(d.id);setJrnl("");setPTmpl(0);}} style={{padding:"5px 9px",fontSize:10,textAlign:"center",borderRadius:5,background:dom===d.id?d.color+"15":"rgba(0,0,0,.03)",color:dom===d.id?d.color:"rgba(0,0,0,.85)",border:"1px solid "+(dom===d.id?d.color+"35":"rgba(0,0,0,.1)"),fontWeight:dom===d.id?600:400,whiteSpace:"nowrap"}}><span style={{marginRight:3}}>{d.icon}</span>{d.label}</button>)}</div>
      {domObj&&domObj.tp&&<div style={{marginBottom:10}}>
        <div className="lb">{lang==="zh"?"论文模板":"Paper Template"}</div>
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{domObj.tp.map((tmpl,i)=><button key={i} onClick={()=>setPTmpl(i)} style={{padding:"4px 10px",fontSize:10,borderRadius:4,background:pTmpl===i?domObj.color+"15":"rgba(0,0,0,.03)",color:pTmpl===i?domObj.color:"rgba(0,0,0,.55)",border:"1px solid "+(pTmpl===i?domObj.color+"30":"rgba(0,0,0,.08)"),fontWeight:pTmpl===i?600:400}}>{tmpl.n}</button>)}</div>
        <div style={{marginTop:4,fontSize:9,color:"rgba(0,0,0,.3)",fontFamily:"monospace"}}>{domObj.tp[pTmpl]?.s?.join(" → ")}</div>
      </div>}
      {domObj&&<div><div className="lb">{t.journal}</div><select value={jrnl} onChange={e=>setJrnl(e.target.value)} style={{marginBottom:8}}><option value="">{domObj.journals[0]}</option>{domObj.journals.map(j=><option key={j} value={j}>{j}</option>)}</select></div>}
      <div className="lb">{t.titleLabel}</div><input value={pTitle} onChange={e=>setPTitle(e.target.value)} placeholder={t.titlePh} style={{marginBottom:8}}/>
      <div className="lb">{t.topicLabel}</div><textarea value={topic} onChange={e=>setTopic(e.target.value)} rows={2} placeholder={t.topicPh} style={{marginBottom:8,resize:"vertical"}}/>
      <div className="lb">{t.keyArgs}</div><input value={args} onChange={e=>setArgs(e.target.value)} placeholder={t.keyArgsPh} style={{marginBottom:8}}/>
      <div className="lb">{t.sdeLens}</div><input value={lens} onChange={e=>setLens(e.target.value)} placeholder={t.sdeLensPh} style={{marginBottom:8}}/>
      <div className="lb">{t.wordsLabel}</div><input type="number" value={wc} onChange={e=>setWc(+e.target.value)} style={{marginBottom:12}}/>
      <button onClick={genPaper} disabled={!dom||(!topic.trim()&&!pTitle.trim())||pBusy} style={{width:"100%",padding:"10px",fontSize:13,fontWeight:700,borderRadius:7,border:"none",background:dom&&(topic.trim()||pTitle.trim())?"linear-gradient(135deg,#8b5cf6,#06b6d4)":"rgba(0,0,0,.1)",color:dom&&(topic.trim()||pTitle.trim())?"#fff":"rgba(0,0,0,.85)"}}>{t.generate}</button>
    </div></div>}

    {tab==="paper"&&pStep==="gen"&&<div style={{flex:1,display:"flex",flexDirection:"column"}}>
      <div style={{padding:"8px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        {!pBusy&&backBtn(()=>setPStep("cfg"))}
        <div style={{flex:1,height:4,borderRadius:2,background:"rgba(0,0,0,.12)"}}><div style={{height:"100%",borderRadius:2,background:"linear-gradient(90deg,#8b5cf6,#06b6d4)",width:Math.round(pProg*100)+"%",transition:"width .5s"}}/></div>
        <span style={{fontSize:10,color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>{Math.round(pProg*100)}%</span>
        {pBusy&&<button onClick={()=>{pAbort.current?.abort();setPBusy(false);}} style={{padding:"3px 10px",fontSize:10,fontWeight:600,borderRadius:4,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444"}}>{t.stop}</button>}</div>
      <div ref={pRef} style={{flex:1,padding:"8px 16px",overflow:"auto",...logStyle}}>{pLogs.map((l,i)=><div key={i} style={{animation:"fi .1s",color:l.c||"rgba(0,0,0,.85)"}}>{l.m}</div>)}</div>
      {!pBusy&&paper&&<div style={{padding:"10px 16px",borderTop:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>setPStep("read")} style={{flex:1,padding:"10px",fontSize:12,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#8b5cf6,#06b6d4)",color:"#fff"}}>{t.viewPaper}</button>
          <button onClick={()=>dl(wordHtml(paper),"SDE_"+safeName(paper)+".doc","application/msword")} style={{padding:"10px 16px",fontSize:12,fontWeight:600,borderRadius:6,border:"1px solid #3b82f650",background:"#3b82f610",color:"#3b82f6"}}>⬇ Word</button>
          <button onClick={()=>dl(mkMd(paper),"SDE_"+safeName(paper)+".md")} style={{padding:"10px 16px",fontSize:12,fontWeight:600,borderRadius:6,border:"1px solid #10b98150",background:"#10b98110",color:"#10b981"}}>⬇ MD</button>
        </div>
      </div>}
    </div>}

    {tab==="paper"&&pStep==="read"&&paper&&renderP(paper,<div style={{flexShrink:0}}>{toolbar(paper,<>{backBtn(()=>setPStep("cfg"))}</>,()=>{const{paper:cp,log}=deepClean({...paper,secs:paper.secs.map(s=>({...s}))});setPaper(cp);setCleanLog(log);})}<div style={{padding:"4px 16px",background:"rgba(250,246,240,.95)",borderBottom:"1px solid rgba(0,0,0,.1)",flexShrink:0}}>
      <button onClick={()=>{setPStep("cfg");setPaper(null);}} style={{padding:"2px 8px",fontSize:9,borderRadius:3,background:"rgba(0,0,0,.1)",color:"rgba(0,0,0,.85)",border:"1px solid rgba(0,0,0,.12)",fontFamily:"monospace"}}>{t.newPaper}</button></div>
      {/* Bottom download bar */}
      <div style={{padding:"12px 16px",background:"rgba(250,246,240,.97)",borderTop:"1px solid rgba(0,0,0,.1)",display:"flex",gap:6}}>
        <button onClick={()=>dl(wordHtml(paper),"SDE_"+safeName(paper)+".doc","application/msword")} style={{flex:1,padding:"12px",fontSize:13,fontWeight:700,borderRadius:7,border:"1px solid #3b82f650",background:"#3b82f610",color:"#3b82f6"}}>⬇ {lang==="zh"?"下载Word论文":"Download Word"}</button>
        <button onClick={()=>dl(mkMd(paper),"SDE_"+safeName(paper)+".md")} style={{flex:1,padding:"12px",fontSize:13,fontWeight:700,borderRadius:7,border:"1px solid #10b98150",background:"#10b98110",color:"#10b981"}}>⬇ {lang==="zh"?"下载Markdown":"Download MD"}</button>
        <button onClick={()=>{setPolPaper(dedupPaper({...paper,secs:paper.secs.map(s=>({...s}))}));setSecFbs({});setPolStep("fb");setTab("polish");}} style={{padding:"12px 16px",fontSize:13,fontWeight:700,borderRadius:7,border:"none",background:"linear-gradient(135deg,#10b981,#06b6d4)",color:"#fff"}}>🔧 {lang==="zh"?"去打磨":"Polish →"}</button>
      </div></div>)}

    {/* ═══ POLISH ═══ */}
    {tab==="polish"&&polStep==="input"&&<div style={{flex:1,overflow:"auto",padding:"16px"}}><div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>{t.polishTitle}</div>
      <div style={{fontSize:11,color:"rgba(0,0,0,.85)",marginBottom:16}}>{t.polInputTitle}</div>

      {paper&&<button onClick={()=>{setPolPaper(dedupPaper({...paper,secs:paper.secs.map(s=>({...s})),kw:[...(paper.kw||[])],refs:[...(paper.refs||[])]}));setSecFbs({});setPolStep("fb");}} style={{width:"100%",padding:"12px",marginBottom:12,fontSize:12,fontWeight:600,borderRadius:8,border:"1px solid rgba(16,185,129,.25)",background:"rgba(16,185,129,.06)",color:"#10b981",textAlign:"left"}}>
        <div style={{fontWeight:700,marginBottom:2}}>{t.polUseGen}</div>
        <div style={{fontSize:11,color:"rgba(16,185,129,.6)"}}>{paper.title} ({paper.secs?.length||0} sections)</div>
      </button>}

      <div style={{padding:"14px",borderRadius:8,background:"rgba(139,92,246,.03)",border:"1px solid rgba(139,92,246,.12)"}}>
        <div className="lb" style={{color:"#8b5cf6"}}>{t.polPasteOwn}</div>

        <div onClick={()=>{const inp=document.createElement("input");inp.type="file";inp.accept=".pdf,.docx,.doc,.txt,.md";inp.onchange=async(e)=>{const file=e.target.files?.[0];if(!file)return;try{const text=await readFileAsText(file);setPolPaperText(text);setPolTitleInput(file.name.replace(/\.\w+$/,"").replace(/[_-]/g," "));}catch(err){setPolPaperText("[Error: "+err.message+"]\n\nTip: Try copy-pasting the text instead.");}};inp.click();}} style={{display:"block",padding:"10px",marginBottom:10,borderRadius:6,border:"1px dashed rgba(139,92,246,.25)",background:"rgba(139,92,246,.03)",textAlign:"center",cursor:"pointer"}}>
          <span style={{fontSize:11,color:"#8b5cf6"}}>📎 {lang==="zh"?"点击上传PDF/Word文件":"Click to upload PDF/Word file"}</span>
        </div>

        <div className="lb">{t.polPaperTitle}</div>
        <input value={polTitleInput} onChange={e=>setPolTitleInput(e.target.value)} placeholder={t.polPaperTitle} style={{marginBottom:8}}/>
        <textarea value={polPaperText} onChange={e=>setPolPaperText(e.target.value)} placeholder={t.polPastePh} rows={8} style={{marginBottom:8,resize:"vertical",lineHeight:1.6,fontSize:11}}/>
        {polPaperText.trim()&&<div style={{fontSize:10,color:"rgba(0,0,0,.8)",fontFamily:"monospace",marginBottom:8,padding:"6px 8px",borderRadius:4,background:"rgba(0,0,0,.05)"}}>
          {(()=>{try{const p=parsePaperText(polPaperText,polTitleInput);return `✓ ${p.secs.length} ${t.polParsed}: ${p.secs.map(s=>s.title).join(", ")}${p.abs?` | abs: ${p.abs.split(/\s+/).length}w`:""}`;}catch(e){return "⚠ "+e.message;}})()}
        </div>}
        <button onClick={()=>{
          try{
            const parsed=parsePaperText(polPaperText,polTitleInput);
            setPolPaper(parsed);setSecFbs({});setPolStep("fb");
          }catch(e){/* ignore */}
        }} disabled={!polPaperText.trim()} style={{width:"100%",padding:"10px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:polPaperText.trim()?"linear-gradient(135deg,#8b5cf6,#06b6d4)":"rgba(0,0,0,.1)",color:polPaperText.trim()?"#fff":"rgba(0,0,0,.85)"}}>{t.polLoadPaper}</button>
      </div>
    </div></div>}

    {tab==="polish"&&polPaper&&polStep==="fb"&&<div style={{flex:1,overflow:"auto",padding:"14px"}}><div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>{backBtn(()=>setPolStep("input"))}<div style={{fontSize:16,fontWeight:700}}>{t.polishTitle}</div></div>
      <div style={{fontSize:11,color:"rgba(0,0,0,.85)",marginBottom:4}}>{polPaper.title}</div>
      <div style={{fontSize:10,color:"rgba(0,0,0,.8)",marginBottom:14,fontFamily:"monospace"}}>{polPaper.secs.length} sections: {polPaper.secs.map(s=>s.title).join(" · ")}</div>

      <div style={{padding:"12px 14px",borderRadius:8,background:"rgba(239,68,68,.04)",border:"1px solid rgba(239,68,68,.12)",marginBottom:14}}>
        <div className="lb" style={{color:"#ef4444"}}>{t.reviewerComments}</div>
        <textarea value={revComments} onChange={e=>setRevComments(e.target.value)} placeholder={t.reviewerPh} rows={6} style={{marginBottom:0,resize:"vertical",lineHeight:1.6,borderColor:"rgba(239,68,68,.2)"}}/>
      </div>

      <div className="lb">{t.overallFb}</div><textarea value={polFb} onChange={e=>setPolFb(e.target.value)} placeholder={t.feedbackPh} rows={3} style={{marginBottom:14,resize:"vertical",lineHeight:1.6}}/>
      <div className="lb">{t.sectionFb}</div>
      {polPaper.secs.map(s=><div key={s.num} style={{marginBottom:6}}><div style={{fontSize:11,color:"rgba(0,0,0,.8)",fontFamily:"monospace",marginBottom:2}}>{s.num}. {s.title}</div>
        <input value={secFbs[s.num]||""} onChange={e=>setSecFbs(p=>({...p,[s.num]:e.target.value}))} placeholder={t.feedbackPh} style={{fontSize:11}}/></div>)}
      <div style={{display:"flex",gap:6,marginTop:14}}>
        <button onClick={()=>{setPolPaper(null);setPolStep("input");}} style={{padding:"10px 16px",fontSize:12,borderRadius:7,border:"1px solid rgba(0,0,0,.1)",background:"transparent",color:"rgba(0,0,0,.85)"}}>{t.reset}</button>
        <button onClick={runPolish} disabled={polBusy} style={{flex:1,padding:"10px",fontSize:13,fontWeight:700,borderRadius:7,border:"none",background:"linear-gradient(135deg,#10b981,#06b6d4)",color:"#fff"}}>{t.startPolish}</button>
      </div>
    </div></div>}

    {tab==="polish"&&polPaper&&polStep==="review"&&<div style={{flex:1,display:"flex",flexDirection:"column"}}>
      <div style={{padding:"8px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>{!polBusy&&backBtn(()=>setPolStep("fb"))}<div><div style={{fontSize:12,fontWeight:600,color:"#10b981"}}>{t.polishStep2}</div>
        {polBusy&&<div style={{fontSize:10,color:"#10b981",fontFamily:"monospace",animation:"pulse 1.5s infinite",marginTop:3}}>▸ {t.reviewing}</div>}</div></div>
      <div ref={polRef} style={{flex:1,padding:"8px 16px",overflow:"auto",...logStyle}}>{polLogs.map((l,i)=><div key={i} style={{animation:"fi .1s",color:l.c||"rgba(0,0,0,.85)"}}>{l.m}</div>)}</div>
      <div style={{padding:"8px 16px",borderTop:"1px solid rgba(0,0,0,.12)",display:"flex",gap:6,flexShrink:0}}>
        {polBusy&&<button onClick={()=>{polAbortRef.current?.abort();setPolBusy(false);}} style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444"}}>{t.stop}</button>}
        {!polBusy&&polished&&<div style={{display:"flex",gap:6}}>
          <button onClick={()=>setPolStep("result")} style={{flex:1,padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"none",background:"linear-gradient(135deg,#10b981,#06b6d4)",color:"#fff"}}>{t.viewPolished}</button>
          <button onClick={()=>dl(wordHtml(polished.paper),"SDE_"+safeName(polished.paper)+".doc","application/msword")} style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"1px solid #3b82f640",background:"#3b82f608",color:"#3b82f6"}}>⬇ Word</button>
          <button onClick={()=>dl(mkMd(polished.paper),"SDE_"+safeName(polished.paper)+".md")} style={{padding:"5px 14px",fontSize:11,fontWeight:600,borderRadius:5,border:"1px solid #10b98140",background:"#10b98108",color:"#10b981"}}>⬇ MD</button>
        </div>}</div>
    </div>}

    {tab==="polish"&&polStep==="result"&&polished&&renderP(polished.paper,<div style={{flexShrink:0}}>{toolbar(polished.paper,<>{backBtn(()=>setPolStep("fb"))}<span style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:"#10b98115",color:"#10b981",fontFamily:"monospace",fontWeight:600}}>{t.polished}</span></>,()=>{const{paper:cp,log}=deepClean({...polished.paper,secs:polished.paper.secs.map(s=>({...s}))});setPolished({...polished,paper:cp});setCleanLog(log);})}
      <div style={{padding:"4px 16px",background:"rgba(250,246,240,.95)",borderBottom:"1px solid rgba(0,0,0,.1)",flexShrink:0}}>
        <button onClick={()=>{setPolStep("fb");setPolished(null);setPolLogs([]);}} style={{padding:"2px 8px",fontSize:9,borderRadius:3,background:"rgba(0,0,0,.1)",color:"rgba(0,0,0,.85)",border:"1px solid rgba(0,0,0,.12)",fontFamily:"monospace"}}>{t.repolish}</button></div>
      {/* Bottom download bar */}
      <div style={{padding:"12px 16px",background:"rgba(250,246,240,.97)",borderTop:"1px solid rgba(0,0,0,.1)",display:"flex",gap:6}}>
        <button onClick={()=>dl(wordHtml(polished.paper),"SDE_"+safeName(polished.paper)+".doc","application/msword")} style={{flex:1,padding:"12px",fontSize:13,fontWeight:700,borderRadius:7,border:"1px solid #3b82f650",background:"#3b82f610",color:"#3b82f6"}}>⬇ {lang==="zh"?"下载Word论文":"Download Word"}</button>
        <button onClick={()=>dl(mkMd(polished.paper),"SDE_"+safeName(polished.paper)+".md")} style={{flex:1,padding:"12px",fontSize:13,fontWeight:700,borderRadius:7,border:"1px solid #10b98150",background:"#10b98110",color:"#10b981"}}>⬇ {lang==="zh"?"下载Markdown":"Download MD"}</button>
        <button onClick={()=>{setRvPaper(polished.paper);setRvStep("input");setTab("review");}} style={{padding:"12px 16px",fontSize:13,fontWeight:700,borderRadius:7,border:"none",background:"linear-gradient(135deg,#f97316,#ef4444)",color:"#fff"}}>⭐ {lang==="zh"?"去审稿":"Review →"}</button>
      </div></div>)}

    {/* ═══ REVIEW - INPUT ═══ */}
    {tab==="review"&&rvStep==="input"&&<div style={{flex:1,overflow:"auto",padding:"16px"}}><div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{fontSize:16,fontWeight:700,color:"#f97316",marginBottom:4}}>{t.reviewTitle}</div>
      <div style={{fontSize:11,color:"rgba(0,0,0,.85)",marginBottom:16}}>{t.rvInputTitle}</div>

      {polished?.paper&&<button onClick={()=>{startReviewWithPaper({...polished.paper,secs:polished.paper.secs.map(s=>({...s}))});}} style={{width:"100%",padding:"12px",marginBottom:8,fontSize:12,fontWeight:600,borderRadius:8,border:"1px solid rgba(16,185,129,.25)",background:"rgba(16,185,129,.06)",color:"#10b981",textAlign:"left"}}>
        <div style={{fontWeight:700,marginBottom:2}}>{t.rvUsePol}</div>
        <div style={{fontSize:11,color:"rgba(16,185,129,.6)"}}>{polished.paper.title} ({polished.paper.secs?.length||0} sections)</div>
      </button>}

      {paper&&<button onClick={()=>{startReviewWithPaper({...paper,secs:paper.secs.map(s=>({...s}))});}} style={{width:"100%",padding:"12px",marginBottom:8,fontSize:12,fontWeight:600,borderRadius:8,border:"1px solid rgba(139,92,246,.25)",background:"rgba(139,92,246,.06)",color:"#8b5cf6",textAlign:"left"}}>
        <div style={{fontWeight:700,marginBottom:2}}>{t.rvUseGen}</div>
        <div style={{fontSize:11,color:"rgba(139,92,246,.6)"}}>{paper.title} ({paper.secs?.length||0} sections)</div>
      </button>}

      <div style={{padding:"14px",borderRadius:8,background:"rgba(249,115,22,.03)",border:"1px solid rgba(249,115,22,.12)"}}>
        <div className="lb" style={{color:"#f97316"}}>{t.rvPasteOwn}</div>
        <div onClick={()=>{const inp=document.createElement("input");inp.type="file";inp.accept=".pdf,.docx,.doc,.txt,.md";inp.onchange=async(e)=>{const file=e.target.files?.[0];if(!file)return;try{const text=await readFileAsText(file);setRvPaperText(text);setRvTitleInput(file.name.replace(/\.\w+$/,"").replace(/[_-]/g," "));}catch(err){setRvPaperText("[Error: "+err.message+"]\n\nTip: Try copy-pasting the text instead.");}};inp.click();}} style={{display:"block",padding:"10px",marginBottom:10,borderRadius:6,border:"1px dashed rgba(249,115,22,.25)",background:"rgba(249,115,22,.03)",textAlign:"center",cursor:"pointer"}}>
          <span style={{fontSize:11,color:"#f97316"}}>📎 {lang==="zh"?"点击上传PDF/Word文件":"Click to upload PDF/Word file"}</span>
        </div>
        <div className="lb">{t.polPaperTitle}</div>
        <input value={rvTitleInput} onChange={e=>setRvTitleInput(e.target.value)} placeholder={t.polPaperTitle} style={{marginBottom:8}}/>
        <textarea value={rvPaperText} onChange={e=>setRvPaperText(e.target.value)} placeholder={t.polPastePh} rows={8} style={{marginBottom:8,resize:"vertical",lineHeight:1.6,fontSize:11}}/>
        {rvPaperText.trim()&&<div style={{fontSize:10,color:"rgba(0,0,0,.8)",fontFamily:"monospace",marginBottom:8,padding:"6px 8px",borderRadius:4,background:"rgba(0,0,0,.05)"}}>
          {(()=>{try{const p=parsePaperText(rvPaperText,rvTitleInput);return `✓ ${p.secs.length} ${t.polParsed}: ${p.secs.map(s=>s.title).join(", ")}`;}catch(e){return "⚠ "+e.message;}})()}
        </div>}
        <button onClick={()=>{
          try{const parsed=parsePaperText(rvPaperText,rvTitleInput);startReviewWithPaper(parsed);}catch(e){}
        }} disabled={!rvPaperText.trim()} style={{width:"100%",padding:"10px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:rvPaperText.trim()?"linear-gradient(135deg,#f97316,#ef4444)":"rgba(0,0,0,.1)",color:rvPaperText.trim()?"#fff":"rgba(0,0,0,.85)"}}>{t.rvLoadPaper}</button>
      </div>

      {/* Score history if exists */}
      {rvHistory.length>0&&<div style={{marginTop:16,padding:"12px 14px",borderRadius:8,background:"rgba(249,115,22,.03)",border:"1px solid rgba(249,115,22,.12)"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#f97316",marginBottom:8}}>{t.reviewHistory}</div>
        <div style={{fontSize:9,fontFamily:"monospace",color:"rgba(0,0,0,.85)"}}>
          {rvHistory.map((h,i)=><div key={i} style={{color:h.avg>=75?"rgba(16,185,129,.7)":"rgba(245,158,11,.7)"}}>{lang==="zh"?`${t.reviewRound}${h.round}次`:`R${h.round}`}: E1={h.e1} E2={h.e2} E3={h.e3} {t.reviewAvg}={h.avg} {h.verdict}</div>)}
        </div>
      </div>}
    </div></div>}

    {/* ═══ REVIEW - SCORING ═══ */}
    {tab==="review"&&(rvStep==="scoring"||rvStep==="result")&&<div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(0,0,0,.12)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>{!rvBusy&&backBtn(()=>setRvStep("input"))}<div><div style={{fontSize:14,fontWeight:700,color:"#f97316"}}>{t.reviewTitle}</div>
            <div style={{fontSize:10,color:"rgba(0,0,0,.85)"}}>{rvPaper?.title}</div></div></div>
          <div style={{display:"flex",gap:4}}>
            {rvBusy?<button onClick={()=>{rvAbort.current?.abort();setRvBusy(false);}} style={{padding:"0 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:"rgba(239,68,68,.15)",color:"#ef4444"}}>{t.stop}</button>
            :<button onClick={runReview} disabled={!rvPaper} style={{padding:"6px 14px",fontSize:12,fontWeight:600,borderRadius:7,border:"none",background:"linear-gradient(135deg,#f97316,#ef4444)",color:"#fff"}}>{rvResult?t.reviewAgain:t.reviewStart}</button>}
          </div>
        </div>
      </div>
      <div ref={rvRef} style={{flex:1,overflow:"auto",padding:"10px 16px"}}>
        {/* Score history */}
        {rvHistory.length>0&&<div style={{marginBottom:16,padding:"12px 14px",borderRadius:8,background:"rgba(249,115,22,.03)",border:"1px solid rgba(249,115,22,.12)"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#f97316",marginBottom:10}}>{t.reviewHistory}</div>
          <div style={{display:"flex",alignItems:"flex-end",gap:3,height:80,marginBottom:8}}>
            {rvHistory.map((h,i)=>{const maxH=70;return <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
              <div style={{fontSize:8,color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>{h.avg}</div>
              <div style={{width:"100%",display:"flex",gap:1,alignItems:"flex-end",justifyContent:"center"}}>
                <div style={{width:4,height:Math.max(2,h.e1*maxH/100),borderRadius:1,background:ROLES.E1.color+"80"}}/>
                <div style={{width:4,height:Math.max(2,h.e2*maxH/100),borderRadius:1,background:ROLES.E2.color+"80"}}/>
                <div style={{width:4,height:Math.max(2,h.e3*maxH/100),borderRadius:1,background:ROLES.E3.color+"80"}}/>
              </div>
              <div style={{fontSize:7,color:"rgba(0,0,0,.8)",fontFamily:"monospace"}}>{lang==="zh"?`${t.reviewRound}${h.round}次`:`R${h.round}`}</div>
            </div>;})}
          </div>
          <div style={{display:"flex",gap:12,justifyContent:"center"}}>
            {[["E1",ROLES.E1.color],["E2",ROLES.E2.color],["E3",ROLES.E3.color]].map(([l,c])=><div key={l} style={{display:"flex",alignItems:"center",gap:3}}><div style={{width:8,height:8,borderRadius:1,background:c+"80"}}/><span style={{fontSize:8,color:"rgba(0,0,0,.85)",fontFamily:"monospace"}}>{l}</span></div>)}
          </div>
        </div>}

        {/* Logs */}
        {rvLogs.map((l,i)=><div key={i} style={{fontFamily:"monospace",fontSize:11,lineHeight:1.8,animation:"fi .1s",color:l.c||"rgba(0,0,0,.85)"}}>{l.m}</div>)}

        {/* Result */}
        {rvResult&&<div style={{marginTop:12,animation:"fi .3s"}}>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            {[["E1",t.reviewE1,rvResult.e1],["E2",t.reviewE2,rvResult.e2],["E3",t.reviewE3,rvResult.e3]].map(([rk,label,data])=><div key={rk} style={{flex:1,padding:"12px",borderRadius:8,background:ROLES[rk].color+"08",border:"1px solid "+ROLES[rk].color+"20",textAlign:"center"}}>
              <div style={{fontSize:9,color:ROLES[rk].color,fontFamily:"monospace",marginBottom:4}}>{label}</div>
              <div style={{fontSize:28,fontWeight:800,color:data.score>=80?"#10b981":data.score>=60?"#f59e0b":"#ef4444"}}>{data.score}</div>
              <div style={{fontSize:8,color:"rgba(0,0,0,.8)"}}>/ 100</div>
            </div>)}
          </div>
          <div style={{textAlign:"center",marginBottom:16,padding:"12px",borderRadius:8,background:"rgba(249,115,22,.06)",border:"1px solid rgba(249,115,22,.15)"}}>
            <div style={{fontSize:10,color:"#f97316",fontFamily:"monospace",marginBottom:2}}>{t.reviewOverall}</div>
            <div style={{fontSize:36,fontWeight:800,color:rvResult.avg>=80?"#10b981":rvResult.avg>=60?"#f59e0b":"#ef4444"}}>{rvResult.avg}</div>
            <div style={{fontSize:13,fontWeight:700,color:rvResult.avg>=75?"#10b981":"#f59e0b",marginTop:4}}>{rvResult.verdict}</div>
          </div>
          {[["E1",t.reviewE1,rvResult.e1],["E2",t.reviewE2,rvResult.e2],["E3",t.reviewE3,rvResult.e3]].map(([rk,label,data])=><div key={rk} style={{marginBottom:10,padding:"10px 12px",borderRadius:8,background:ROLES[rk].color+"06",border:"1px solid "+ROLES[rk].color+"15",borderLeft:"3px solid "+ROLES[rk].color+"40"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
              <div style={{display:"flex",alignItems:"center",gap:5}}><span style={{color:ROLES[rk].color}}>{ROLES[rk].icon}</span><span style={{color:ROLES[rk].color,fontSize:11,fontWeight:600,fontFamily:"monospace"}}>{label}: {data.score}/100</span></div>
              <Cp text={data.comments}/>
            </div>
            <div style={{fontSize:11,lineHeight:1.7,color:"rgba(0,0,0,.85)",whiteSpace:"pre-wrap"}}>{data.comments}</div>
          </div>)}
          <div style={{display:"flex",gap:6,marginTop:12}}>
            <button onClick={()=>{
              setPolPaper(rvPaper);setSecFbs({});setPolFb("");setPolished(null);setPolLogs([]);
              const comments=[rvResult.e1&&`E1 (${t.reviewE1}):\n${rvResult.e1.comments.substring(0,500)}`,rvResult.e2&&`E2 (${t.reviewE2}):\n${rvResult.e2.comments.substring(0,500)}`,rvResult.e3&&`E3 (${t.reviewE3}):\n${rvResult.e3.comments.substring(0,500)}`].filter(Boolean).join("\n\n");
              setRevComments(comments);setPolStep("fb");setTab("polish");
            }} style={{flex:1,padding:"9px",fontSize:12,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#10b981,#06b6d4)",color:"#fff"}}>{t.reviewToPolish}</button>
            <button onClick={runReview} disabled={rvBusy} style={{flex:1,padding:"9px",fontSize:12,fontWeight:600,borderRadius:6,border:"none",background:"linear-gradient(135deg,#f97316,#ef4444)",color:"#fff"}}>{t.reviewAgain}</button>
            <button onClick={()=>{setRvPaper(null);setRvResult(null);setRvLogs([]);setRvStep("input");setRvAutoStart(false);}} style={{padding:"9px 14px",fontSize:12,borderRadius:6,border:"1px solid rgba(0,0,0,.1)",background:"transparent",color:"rgba(0,0,0,.85)"}}>{t.reset}</button>
          </div>
          {rvPaper&&<div style={{display:"flex",gap:4,marginTop:6}}>
            <button onClick={()=>dl(wordHtml(rvPaper),"SDE_"+safeName(rvPaper)+".doc","application/msword")} style={{flex:1,padding:"8px",fontSize:11,fontWeight:600,borderRadius:5,border:"1px solid #3b82f640",background:"#3b82f610",color:"#3b82f6"}}>⬇ {lang==="zh"?"下载Word":"Download Word"}</button>
            <button onClick={()=>dl(mkMd(rvPaper),"SDE_"+safeName(rvPaper)+".md")} style={{flex:1,padding:"8px",fontSize:11,fontWeight:600,borderRadius:5,border:"1px solid #10b98140",background:"#10b98110",color:"#10b981"}}>⬇ {lang==="zh"?"下载Markdown":"Download MD"}</button>
          </div>}
        </div>}

        {rvPaper&&!rvResult&&!rvBusy&&rvLogs.length===0&&<div style={{textAlign:"center",paddingTop:40,color:"rgba(0,0,0,.1)"}}>
          <div style={{fontSize:32,marginBottom:8}}>⭐</div>
          <div style={{fontSize:12,marginBottom:4}}>{rvPaper.title}</div>
          <div style={{fontSize:10,color:"rgba(0,0,0,.12)"}}>{rvPaper.secs?.length||0}{lang==="zh"?"节 · 点击上方按钮开始审稿":"sec · Click button to start"}</div>
        </div>}
      </div>
    </div>}
  </div>);
}
