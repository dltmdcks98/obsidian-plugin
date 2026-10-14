export type Warning={code:string;message:string};
export type Asset={assetId:string;sha256:string;mediaType:'image/png'|'image/jpeg'|'image/gif'|'image/webp';size:number};
export type Styles={profileId:"obsidian-static-v1";elements:{id:string;declarations:Record<string,string>}[]};
export type Draft={sourceId:string;expectedRevision:number;title:string;slug:string;summary:string;tags:string[];html:string;styles:Styles;assets:Asset[];renderer:{schemaVersion:1;profile:"obsidian-static-v1";obsidianVersion:string;pluginVersion:string};warnings:Warning[]};
export type Post={postId:string;sourceId:string;draftRevision:number;publishedRevision:number|null;status:string;slug:string;previewPath:string;warnings:Warning[]};
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function uuid():string{if(!globalThis.crypto?.randomUUID)throw new Error("안전한 UUID 생성 기능이 필요합니다.");return crypto.randomUUID();}
export async function sha256(bytes:ArrayBuffer|string):Promise<string>{if(!crypto?.subtle)throw new Error("WebCrypto SHA-256 기능이 필요합니다.");const b=typeof bytes==="string"?new TextEncoder().encode(bytes):bytes;return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",b)),v=>v.toString(16).padStart(2,"0")).join("");}
export const warn=(code:string):Warning=>({code,message:({PRIVATE_CONTENT_BLOCKED:"비공개 참조 또는 원시 HTML을 제외했습니다.",UNSUPPORTED_WIDGET:"지원하지 않는 동적 콘텐츠를 제외했습니다.",IMAGE_NOT_SELECTED:"선택하지 않은 이미지를 제외했습니다.",STYLE_DIFFERENCE:"서버 정규화 결과와 로컬 정적 사본이 다를 수 있습니다."} as Record<string,string>)[code]||"지원하지 않는 콘텐츠를 제외했습니다."});
export function slugValid(s:string):boolean{return s.length<=160&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)&&!["legacy","admin","assets","feed","sitemap"].includes(s);}
