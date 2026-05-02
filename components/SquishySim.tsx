// "use client";
// // ─────────────────────────────────────────────────────────────────────────────
// //  components/SquishySim.tsx
// //  Raw WebGL2 soft-body / fracture simulation.  No Three.js.
// //  Drop this file into components/ and keep app/ exactly as-is.
// // ─────────────────────────────────────────────────────────────────────────────

// import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

// // ═══════════════════════════════════════════════════════
// //  GLSL SHADERS
// // ═══════════════════════════════════════════════════════

// const BODY_VS = `#version 300 es
// precision highp float;
// in vec3 aPosition;
// in vec3 aNormal;
// uniform mat4 uModel, uView, uProj;
// out vec3 vPos, vNorm;
// void main() {
//   vec4 w = uModel * vec4(aPosition, 1.0);
//   gl_Position = uProj * uView * w;
//   vPos  = w.xyz;
//   vNorm = mat3(uModel) * aNormal;   // model=identity so just passes through
// }`;

// const BODY_FS = `#version 300 es
// precision highp float;
// in vec3 vPos, vNorm;
// uniform vec3 uLightPos, uCamPos, uColor;
// out vec4 fragColor;
// void main() {
//   vec3 N = normalize(vNorm);
//   if (!gl_FrontFacing) N = -N;           // correctly light torn-open interior
//   vec3 L = normalize(uLightPos - vPos);
//   vec3 H = normalize(L + normalize(uCamPos - vPos));
//   float diff = max(dot(N,L), 0.0);
//   float spec = pow(max(dot(H,N), 0.0), 80.0);
//   fragColor = vec4(uColor*(0.18 + diff*0.75) + vec3(1,.97,.85)*spec*0.6, 1.0);
// }`;

// // Used for floor quad and spring lines
// const FLAT_VS = `#version 300 es
// precision highp float;
// in vec3 aPosition;
// uniform mat4 uMVP;
// out vec2 vUV;
// void main() { gl_Position = uMVP * vec4(aPosition,1.); vUV = aPosition.xz*.5; }`;

// const FLOOR_FS = `#version 300 es
// precision highp float;
// in vec2 vUV; out vec4 fc;
// void main() {
//   vec2 g = abs(fract(vUV)-.5);
//   float line = 1.-smoothstep(0.,.04,min(g.x,g.y));
//   fc = vec4(vec3(.09+line*.05),1.);
// }`;

// const LINE_FS = `#version 300 es
// precision highp float;
// out vec4 fc;
// void main() { fc = vec4(.53,.35,.1,.45); }`;

// // ═══════════════════════════════════════════════════════
// //  MATH  (column-major Float32Array, matching WebGL)
// // ═══════════════════════════════════════════════════════

// const cross3  = (a: number[], b: number[]) =>
//   [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
// const len3    = (v: number[]) => Math.sqrt(v[0]**2+v[1]**2+v[2]**2);
// const norm3   = (v: number[]) => { const l=len3(v)||1; return v.map(x=>x/l); };

// function mat4Persp(fov: number, asp: number, n: number, f: number): Float32Array {
//   const t=1/Math.tan(fov*.5), nf=1/(n-f), m=new Float32Array(16);
//   m[0]=t/asp; m[5]=t; m[10]=(f+n)*nf; m[11]=-1; m[14]=2*f*n*nf; return m;
// }
// function mat4LookAt(eye: number[], ctr: number[], up: number[]): Float32Array {
//   const z=norm3([eye[0]-ctr[0],eye[1]-ctr[1],eye[2]-ctr[2]]);
//   const x=norm3(cross3(up,z)), y=cross3(z,x), m=new Float32Array(16);
//   m[0]=x[0];m[1]=y[0];m[2]=z[0]; m[4]=x[1];m[5]=y[1];m[6]=z[1];
//   m[8]=x[2];m[9]=y[2];m[10]=z[2];
//   m[12]=-(x[0]*eye[0]+x[1]*eye[1]+x[2]*eye[2]);
//   m[13]=-(y[0]*eye[0]+y[1]*eye[1]+y[2]*eye[2]);
//   m[14]=-(z[0]*eye[0]+z[1]*eye[1]+z[2]*eye[2]); m[15]=1; return m;
// }
// function mat4Mul(a: Float32Array, b: Float32Array): Float32Array {
//   const m=new Float32Array(16);
//   for(let c=0;c<4;c++) for(let r=0;r<4;r++){
//     let s=0; for(let k=0;k<4;k++) s+=a[k*4+r]*b[c*4+k]; m[c*4+r]=s;
//   } return m;
// }
// function mat4Id(): Float32Array { const m=new Float32Array(16); m[0]=m[5]=m[10]=m[15]=1; return m; }

// // ═══════════════════════════════════════════════════════
// //  PHYSICS TYPES
// // ═══════════════════════════════════════════════════════

// interface Spring { i:number; j:number; rest:number; broken:boolean; }
// export type Shape = "cube"|"sphere"|"tower";

// interface ShapeData {
//   N:number; positions:Float32Array;
//   springPairs:Array<[number,number,number]>;
//   faces:Array<{vertToParticle:number[];triIdx:number[]}>;
// }

// // ═══════════════════════════════════════════════════════
// //  SHAPE BUILDERS
// // ═══════════════════════════════════════════════════════

// function buildGrid(gx:number,gy:number,gz:number,s:number,y0:number): ShapeData {
//   const N=gx*gy*gz, pidx=(x:number,y:number,z:number)=>(x*gy+y)*gz+z;
//   const hx=(gx-1)*s*.5, hy=(gy-1)*s*.5, hz=(gz-1)*s*.5;
//   const positions=new Float32Array(N*3);
//   for(let x=0;x<gx;x++) for(let y=0;y<gy;y++) for(let z=0;z<gz;z++){
//     const i=pidx(x,y,z);
//     positions[i*3]=x*s-hx; positions[i*3+1]=y0+y*s; positions[i*3+2]=z*s-hz;
//   }
//   const springPairs:Array<[number,number,number]>=[];
//   for(let x=0;x<gx;x++) for(let y=0;y<gy;y++) for(let z=0;z<gz;z++){
//     for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++) for(let dz=-1;dz<=1;dz++){
//       if(!dx&&!dy&&!dz) continue;
//       if(dx<0||(dx===0&&dy<0)||(dx===0&&dy===0&&dz<0)) continue;
//       const nx=x+dx,ny=y+dy,nz=z+dz;
//       if(nx<0||nx>=gx||ny<0||ny>=gy||nz<0||nz>=gz) continue;
//       springPairs.push([pidx(x,y,z),pidx(nx,ny,nz),Math.hypot(dx,dy,dz)*s]);
//     }
//     for(const [dx,dy,dz] of [[2,0,0],[0,2,0],[0,0,2]] as [number,number,number][]){
//       const nx=x+dx,ny=y+dy,nz=z+dz;
//       if(nx>=gx||ny>=gy||nz>=gz) continue;
//       springPairs.push([pidx(x,y,z),pidx(nx,ny,nz),Math.hypot(dx,dy,dz)*s]);
//     }
//   }
//   const faceDefs:Array<[(u:number,v:number)=>number,number,number]>=[
//     [(u,v)=>pidx(u,v,0),gx,gy],[(u,v)=>pidx(u,v,gz-1),gx,gy],
//     [(u,v)=>pidx(0,u,v),gy,gz],[(u,v)=>pidx(gx-1,u,v),gy,gz],
//     [(u,v)=>pidx(u,0,v),gx,gz],[(u,v)=>pidx(u,gy-1,v),gx,gz],
//   ];
//   const faces=faceDefs.map(([fn,nu,nv])=>{
//     const vertToParticle:number[]=[];
//     for(let v=0;v<nv;v++) for(let u=0;u<nu;u++) vertToParticle.push(fn(u,v));
//     const triIdx:number[]=[];
//     for(let v=0;v<nv-1;v++) for(let u=0;u<nu-1;u++){
//       const a=v*nu+u,b=v*nu+u+1,c=(v+1)*nu+u,d=(v+1)*nu+u+1;
//       triIdx.push(a,b,d,a,d,c);
//     } return {vertToParticle,triIdx};
//   });
//   return {N,positions,springPairs,faces};
// }

// function buildSphere(): ShapeData {
//   const G=7,s=.36,y0=2.8;
//   const d=buildGrid(G,G,G,s,y0);
//   const half=(G-1)*s*.5, R=half*1.05, maxR=half*Math.sqrt(3);
//   for(let i=0;i<d.N;i++){
//     const px=d.positions[i*3], py=d.positions[i*3+1]-y0-half, pz=d.positions[i*3+2];
//     const r=Math.sqrt(px*px+py*py+pz*pz)||1e-8, nr=R*(r/maxR);
//     d.positions[i*3]=(px/r)*nr; d.positions[i*3+1]=y0+half+(py/r)*nr; d.positions[i*3+2]=(pz/r)*nr;
//   }
//   const newPairs=d.springPairs.map(([si,sj])=>{
//     const dx=d.positions[si*3]-d.positions[sj*3];
//     const dy=d.positions[si*3+1]-d.positions[sj*3+1];
//     const dz=d.positions[si*3+2]-d.positions[sj*3+2];
//     return [si,sj,Math.sqrt(dx*dx+dy*dy+dz*dz)] as [number,number,number];
//   });
//   return {...d,springPairs:newPairs};
// }

// const SHAPES:Record<Shape,()=>ShapeData>={
//   cube:  ()=>buildGrid(6,6,6,.38,2.5),
//   sphere:buildSphere,
//   tower: ()=>buildGrid(3,10,3,.38,.5),
// };

// // ═══════════════════════════════════════════════════════
// //  WEBGL HELPERS
// // ═══════════════════════════════════════════════════════

// function mkProg(gl:WebGL2RenderingContext,vs:string,fs:string):WebGLProgram{
//   const mk=(t:number,src:string)=>{
//     const s=gl.createShader(t)!; gl.shaderSource(s,src); gl.compileShader(s);
//     if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)!); return s;
//   };
//   const p=gl.createProgram()!;
//   gl.attachShader(p,mk(gl.VERTEX_SHADER,vs)); gl.attachShader(p,mk(gl.FRAGMENT_SHADER,fs));
//   gl.linkProgram(p);
//   if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
//   return p;
// }

// interface FaceMesh { vao:WebGLVertexArrayObject; posBuf:WebGLBuffer; normBuf:WebGLBuffer; idxBuf:WebGLBuffer; cnt:number; }

// function mkFaceMesh(gl:WebGL2RenderingContext,prog:WebGLProgram,nv:number,idx:Uint32Array):FaceMesh{
//   const vao=gl.createVertexArray()!,posBuf=gl.createBuffer()!,normBuf=gl.createBuffer()!,idxBuf=gl.createBuffer()!;
//   gl.bindVertexArray(vao);
//   const aPos=gl.getAttribLocation(prog,"aPosition");
//   gl.bindBuffer(gl.ARRAY_BUFFER,posBuf); gl.bufferData(gl.ARRAY_BUFFER,nv*3*4,gl.DYNAMIC_DRAW);
//   gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos,3,gl.FLOAT,false,0,0);
//   const aNrm=gl.getAttribLocation(prog,"aNormal");
//   gl.bindBuffer(gl.ARRAY_BUFFER,normBuf); gl.bufferData(gl.ARRAY_BUFFER,nv*3*4,gl.DYNAMIC_DRAW);
//   gl.enableVertexAttribArray(aNrm); gl.vertexAttribPointer(aNrm,3,gl.FLOAT,false,0,0);
//   gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,idx,gl.STATIC_DRAW);
//   gl.bindVertexArray(null);
//   return {vao,posBuf,normBuf,idxBuf,cnt:idx.length};
// }

// function recomputeNormals(pos:Float32Array,idx:Uint32Array,out:Float32Array):void{
//   out.fill(0);
//   for(let t=0;t<idx.length;t+=3){
//     const i0=idx[t],i1=idx[t+1],i2=idx[t+2];
//     const ax=pos[i0*3],ay=pos[i0*3+1],az=pos[i0*3+2];
//     const e1=[pos[i1*3]-ax,pos[i1*3+1]-ay,pos[i1*3+2]-az];
//     const e2=[pos[i2*3]-ax,pos[i2*3+1]-ay,pos[i2*3+2]-az];
//     const n=cross3(e1,e2);
//     for(const i of [i0,i1,i2]){out[i*3]+=n[0];out[i*3+1]+=n[1];out[i*3+2]+=n[2];}
//   }
//   for(let i=0;i<out.length/3;i++){
//     const l=Math.sqrt(out[i*3]**2+out[i*3+1]**2+out[i*3+2]**2)||1;
//     out[i*3]/=l;out[i*3+1]/=l;out[i*3+2]/=l;
//   }
// }

// // ═══════════════════════════════════════════════════════
// //  CONFIG
// // ═══════════════════════════════════════════════════════
// interface Cfg { stiffness:number; damping:number; breakRatio:number; substeps:number; }
// interface Actions { reset(s:Shape):void; drop():void; smash():void; melt():void; toggleSprings():void; toggleWireframe():void; }
// interface SlRow { label:string; min:number; max:number; step:number; def:number; fmt:(v:number)=>string; onChange:(v:number)=>void; }
// interface BtnP  { onClick:()=>void; children:ReactNode; }

// const GRAVITY=18, FLOOR_Y=-2.8, DT=1/60, FOV=Math.PI/4;

// // ═══════════════════════════════════════════════════════
// //  COMPONENT
// // ═══════════════════════════════════════════════════════
// export default function SquishySim(){
//   const cvs       = useRef<HTMLCanvasElement>(null);
//   const stBroken  = useRef<HTMLElement>(null);
//   const stPct     = useRef<HTMLElement>(null);
//   const stStatus  = useRef<HTMLElement>(null);
//   const stSprings = useRef<HTMLElement>(null);
//   const cfg       = useRef<Cfg>({stiffness:380,damping:.95,breakRatio:.6,substeps:8});
//   const act       = useRef<Actions|null>(null);

//   useEffect(()=>{
//     const canvas=cvs.current!;
//     const resize=()=>{ canvas.width=canvas.clientWidth; canvas.height=canvas.clientHeight; };
//     resize();
//     const gl=canvas.getContext("webgl2");
//     if(!gl){ console.error("WebGL2 unavailable"); return; }

//     // ── Programs ───────────────────────────────────────
//     const bodyProg =mkProg(gl,BODY_VS,BODY_FS);
//     const flatProg =mkProg(gl,FLAT_VS,FLOOR_FS);
//     const lineProg =mkProg(gl,FLAT_VS,LINE_FS);

//     // ── Floor ──────────────────────────────────────────
//     const h=12;
//     const floorVerts=new Float32Array([-h,FLOOR_Y,h, h,FLOOR_Y,h, h,FLOOR_Y,-h, -h,FLOOR_Y,h, h,FLOOR_Y,-h, -h,FLOOR_Y,-h]);
//     const floorVAO=gl.createVertexArray()!;
//     gl.bindVertexArray(floorVAO);
//     const fb=gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER,fb);
//     gl.bufferData(gl.ARRAY_BUFFER,floorVerts,gl.STATIC_DRAW);
//     const fp=gl.getAttribLocation(flatProg,"aPosition");
//     gl.enableVertexAttribArray(fp); gl.vertexAttribPointer(fp,3,gl.FLOAT,false,0,0);
//     gl.bindVertexArray(null);

//     // ── GL state ───────────────────────────────────────
//     gl.enable(gl.DEPTH_TEST);
//     gl.clearColor(.027,.027,.054,1);

//     // ── Camera (arcball) ───────────────────────────────
//     let theta=.35, phi=.30, dist=11;
//     const target=[0,.5,0];
//     let dragging=false, lx=0, ly=0;

//     function getEye():[number,number,number]{
//       const cr=dist*Math.cos(phi);
//       return [target[0]+cr*Math.sin(theta), target[1]+dist*Math.sin(phi), target[2]+cr*Math.cos(theta)];
//     }

//     canvas.addEventListener("mousedown",e=>{dragging=true;lx=e.clientX;ly=e.clientY;});
//     canvas.addEventListener("mouseup",  ()=>{dragging=false;});
//     canvas.addEventListener("mousemove",e=>{
//       if(!dragging) return;
//       theta-=(e.clientX-lx)*.007; phi=Math.max(-1.4,Math.min(1.4,phi-(e.clientY-ly)*.007));
//       lx=e.clientX; ly=e.clientY;
//     });
//     canvas.addEventListener("wheel",e=>{dist=Math.max(3,Math.min(22,dist+e.deltaY*.01));},{passive:true});

//     // ── Physics state ──────────────────────────────────
//     let pos=new Float32Array(0), prev=new Float32Array(0), facc=new Float32Array(0);
//     let springs:Spring[]=[], N=0, dropped=false;

//     // ── Face meshes ────────────────────────────────────
//     interface FaceData { v2p:number[]; idx:Uint32Array; pos:Float32Array; nrm:Float32Array; }
//     let faceMeshes:FaceMesh[]=[], faceData:FaceData[]=[];
//     let wireframe=false, showSprings=false;

//     function rebuildFaces(faces:{vertToParticle:number[];triIdx:number[]}[]){
//       for(const f of faceMeshes){gl.deleteBuffer(f.posBuf);gl.deleteBuffer(f.normBuf);gl.deleteBuffer(f.idxBuf);gl.deleteVertexArray(f.vao);}
//       faceMeshes=[]; faceData=[];
//       for(const {vertToParticle,triIdx} of faces){
//         const nv=vertToParticle.length, idx=new Uint32Array(triIdx);
//         faceMeshes.push(mkFaceMesh(gl,bodyProg,nv,idx));
//         faceData.push({v2p:vertToParticle,idx,pos:new Float32Array(nv*3),nrm:new Float32Array(nv*3)});
//       }
//     }

//     function syncFaces(){
//       for(let fi=0;fi<faceData.length;fi++){
//         const fd=faceData[fi], fm=faceMeshes[fi];
//         for(let vi=0;vi<fd.v2p.length;vi++){
//           const pi=fd.v2p[vi];
//           fd.pos[vi*3]=pos[pi*3]; fd.pos[vi*3+1]=pos[pi*3+1]; fd.pos[vi*3+2]=pos[pi*3+2];
//         }
//         recomputeNormals(fd.pos,fd.idx,fd.nrm);
//         gl.bindBuffer(gl.ARRAY_BUFFER,fm.posBuf); gl.bufferSubData(gl.ARRAY_BUFFER,0,fd.pos);
//         gl.bindBuffer(gl.ARRAY_BUFFER,fm.normBuf); gl.bufferSubData(gl.ARRAY_BUFFER,0,fd.nrm);
//       }
//     }

//     // ── Spring lines (optional debug) ──────────────────
//     let springVAO:WebGLVertexArrayObject|null=null, springBuf:WebGLBuffer|null=null;

//     function syncSpringLines(){
//       const alive=springs.filter(s=>!s.broken);
//       const v=new Float32Array(alive.length*6);
//       alive.forEach(({i,j},k)=>{
//         v[k*6]=pos[i*3]; v[k*6+1]=pos[i*3+1]; v[k*6+2]=pos[i*3+2];
//         v[k*6+3]=pos[j*3]; v[k*6+4]=pos[j*3+1]; v[k*6+5]=pos[j*3+2];
//       });
//       if(!springVAO){
//         springVAO=gl.createVertexArray()!; springBuf=gl.createBuffer()!;
//         gl.bindVertexArray(springVAO);
//         gl.bindBuffer(gl.ARRAY_BUFFER,springBuf);
//         const ap=gl.getAttribLocation(lineProg,"aPosition");
//         gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap,3,gl.FLOAT,false,0,0);
//         gl.bindVertexArray(null);
//       }
//       gl.bindBuffer(gl.ARRAY_BUFFER,springBuf!);
//       gl.bufferData(gl.ARRAY_BUFFER,v,gl.DYNAMIC_DRAW);
//       return alive.length*2;
//     }

//     // ── Load shape ─────────────────────────────────────
//     function loadShape(shape:Shape){
//       const d=SHAPES[shape](); N=d.N;
//       pos=new Float32Array(d.positions); prev=new Float32Array(d.positions); facc=new Float32Array(N*3);
//       springs=d.springPairs.map(([i,j,r])=>({i,j,rest:r,broken:false}));
//       dropped=false;
//       rebuildFaces(d.faces);
//       if(stSprings.current) stSprings.current.textContent=String(springs.length);
//       if(stStatus.current)  stStatus.current.textContent="READY";
//       if(stBroken.current)  stBroken.current.textContent="0";
//       if(stPct.current)     stPct.current.textContent="0%";
//     }

//     // ── Physics step ───────────────────────────────────
//     function step(){
//       if(!dropped) return;
//       const {stiffness,damping,breakRatio,substeps}=cfg.current;
//       const sdt2=(DT/substeps)**2;
//       for(let sub=0;sub<substeps;sub++){
//         facc.fill(0);
//         for(let i=0;i<N;i++) facc[i*3+1]-=GRAVITY;
//         for(const sp of springs){
//           if(sp.broken) continue;
//           const {i,j}=sp;
//           const dx=pos[j*3]-pos[i*3], dy=pos[j*3+1]-pos[i*3+1], dz=pos[j*3+2]-pos[i*3+2];
//           const len=Math.sqrt(dx*dx+dy*dy+dz*dz)||1e-8;
//           const stretch=len-sp.rest;
//           if(stretch/sp.rest>breakRatio){sp.broken=true;continue;}
//           const f=stiffness*stretch/len;
//           facc[i*3]+=f*dx; facc[i*3+1]+=f*dy; facc[i*3+2]+=f*dz;
//           facc[j*3]-=f*dx; facc[j*3+1]-=f*dy; facc[j*3+2]-=f*dz;
//         }
//         for(let i=0;i<N;i++){
//           const px=pos[i*3],py=pos[i*3+1],pz=pos[i*3+2];
//           const ox=prev[i*3],oy=prev[i*3+1],oz=prev[i*3+2];
//           const vx=(px-ox)*damping,vy=(py-oy)*damping,vz=(pz-oz)*damping;
//           let nx=px+vx+facc[i*3]*sdt2, ny=py+vy+facc[i*3+1]*sdt2, nz=pz+vz+facc[i*3+2]*sdt2;
//           prev[i*3]=px; prev[i*3+1]=py; prev[i*3+2]=pz;
//           if(ny<FLOOR_Y+.05){
//             ny=FLOOR_Y+.05; prev[i*3+1]=ny+vy*.25;
//             prev[i*3]=nx-(nx-px)*.35; prev[i*3+2]=nz-(nz-pz)*.35;
//           }
//           pos[i*3]=nx; pos[i*3+1]=ny; pos[i*3+2]=nz;
//         }
//       }
//     }

//     // ── Actions ────────────────────────────────────────
//     act.current={
//       reset: (s)=>loadShape(s),
//       drop:  ()=>{dropped=true; if(stStatus.current) stStatus.current.textContent="SIMULATING";},
//       smash: ()=>{
//         if(!dropped) dropped=true;
//         for(let i=0;i<N;i++){
//           const str=Math.max(0,1.4-Math.hypot(pos[i*3],pos[i*3+2])*.8);
//           const j=(Math.random()-.5)*.12;
//           prev[i*3+1]=pos[i*3+1]+str*1.8; prev[i*3]-=j; prev[i*3+2]-=j;
//         }
//         if(stStatus.current) stStatus.current.textContent="SMASHED";
//       },
//       melt:  ()=>{springs.forEach(s=>(s.broken=true)); if(stStatus.current) stStatus.current.textContent="MELTED";},
//       toggleSprings:  ()=>{showSprings=!showSprings;},
//       toggleWireframe:()=>{wireframe=!wireframe;},
//     };

//     // ── Click-to-poke  (ray-sphere, world space) ───────
//     canvas.addEventListener("click",e=>{
//       if(!dropped) return;
//       const eye=getEye();
//       // Camera axes from view matrix rows (view is column-major, rows = right/up/back)
//       const view=mat4LookAt(eye,target,[0,1,0]);
//       const right=[view[0],view[4],view[8]];
//       const up   =[view[1],view[5],view[9]];
//       const fwd  =[-view[2],-view[6],-view[10]];
//       const t=Math.tan(FOV*.5), asp=canvas.width/canvas.height;
//       const ndx=(e.clientX/canvas.width)*2-1, ndy=(e.clientY/canvas.height)*-2+1;
//       const rd=norm3([fwd[0]+right[0]*ndx*asp*t+up[0]*ndy*t,
//                       fwd[1]+right[1]*ndx*asp*t+up[1]*ndy*t,
//                       fwd[2]+right[2]*ndx*asp*t+up[2]*ndy*t]);
//       let best=-1, bestD=0.6;
//       for(let i=0;i<N;i++){
//         const px=pos[i*3]-eye[0],py=pos[i*3+1]-eye[1],pz=pos[i*3+2]-eye[2];
//         const tt=px*rd[0]+py*rd[1]+pz*rd[2]; if(tt<0) continue;
//         const d=Math.sqrt((px-tt*rd[0])**2+(py-tt*rd[1])**2+(pz-tt*rd[2])**2);
//         if(d<bestD){bestD=d;best=i;}
//       }
//       if(best>=0){
//         const s=.5;
//         prev[best*3]  =pos[best*3]  -rd[0]*s;
//         prev[best*3+1]=pos[best*3+1]-rd[1]*s;
//         prev[best*3+2]=pos[best*3+2]-rd[2]*s;
//       }
//     });

//     // ── Render ─────────────────────────────────────────
//     function render(){
//       gl.viewport(0,0,canvas.width,canvas.height);
//       gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);

//       const eye=getEye();
//       const proj=mat4Persp(FOV,canvas.width/canvas.height,.1,80);
//       const view=mat4LookAt(eye,target,[0,1,0]);
//       const mvp =mat4Mul(proj,view); // model=identity
//       const id  =mat4Id();

//       // Floor
//       gl.useProgram(flatProg);
//       gl.uniformMatrix4fv(gl.getUniformLocation(flatProg,"uMVP"),false,mvp);
//       gl.bindVertexArray(floorVAO); gl.drawArrays(gl.TRIANGLES,0,6);

//       // Body faces
//       gl.useProgram(bodyProg);
//       gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg,"uModel"),false,id);
//       gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg,"uView"), false,view);
//       gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg,"uProj"), false,proj);
//       gl.uniform3fv(gl.getUniformLocation(bodyProg,"uLightPos"),[8,15,8]);
//       gl.uniform3fv(gl.getUniformLocation(bodyProg,"uCamPos"),eye);
//       gl.uniform3fv(gl.getUniformLocation(bodyProg,"uColor"),wireframe?[.8,.6,.1]:[1,.843,0]);

//       gl.disable(gl.CULL_FACE);
//       for(let fi=0;fi<faceMeshes.length;fi++){
//         const m=faceMeshes[fi]; gl.bindVertexArray(m.vao);
//         gl.drawElements(wireframe?gl.LINES:gl.TRIANGLES,m.cnt,gl.UNSIGNED_INT,0);
//       }
//       gl.enable(gl.CULL_FACE);

//       // Spring lines
//       if(showSprings){
//         const cnt=syncSpringLines();
//         gl.useProgram(lineProg);
//         gl.uniformMatrix4fv(gl.getUniformLocation(lineProg,"uMVP"),false,mvp);
//         gl.bindVertexArray(springVAO); gl.drawArrays(gl.LINES,0,cnt);
//       }
//       gl.bindVertexArray(null);
//     }

//     // ── Animation loop ─────────────────────────────────
//     let tick=0, raf=0;
//     function loop(){
//       raf=requestAnimationFrame(loop);
//       step(); syncFaces(); render();
//       if(tick++%15===0){
//         const b=springs.filter(s=>s.broken).length, t=springs.length;
//         if(stBroken.current) stBroken.current.textContent=String(b);
//         if(stPct.current) stPct.current.textContent=t?(b/t*100).toFixed(1)+"%":"0%";
//       }
//     }

//     window.addEventListener("resize",resize);
//     loadShape("cube");
//     loop();

//     return ()=>{
//       cancelAnimationFrame(raf);
//       window.removeEventListener("resize",resize);
//     };
//   },[]);

//   // ── JSX ───────────────────────────────────────────────
//   return(
//     <div style={s.root}>
//       <canvas ref={cvs} style={s.canvas}/>

//       <div style={s.hud}>
//         <h2 style={s.hudTitle}>⬡ Squishy Fracture Sim</h2>
//         <p style={s.row}>Springs : <b ref={stSprings} style={s.gold}>—</b></p>
//         <p style={s.row}>Broken  : <b ref={stBroken} style={s.gold}>0</b>
//           &nbsp;(<b ref={stPct} style={s.gold}>0%</b>)</p>
//         <p style={s.row}>Status  : <b ref={stStatus} style={s.gold}>READY</b></p>
//       </div>

//       <div style={s.panel}>
//         <SRow label="Stiffness" min={50}  max={1500} step={25} def={380} fmt={v=>String(v)}          onChange={v=>{cfg.current.stiffness =v;}}/>
//         <SRow label="Damping"   min={88}  max={99}   step={1}  def={95}  fmt={v=>(v/100).toFixed(2)} onChange={v=>{cfg.current.damping   =v/100;}}/>
//         <SRow label="Break %"   min={10}  max={200}  step={5}  def={60}  fmt={v=>v+"%"}              onChange={v=>{cfg.current.breakRatio=v/100;}}/>
//         <SRow label="Substeps"  min={1}   max={20}   step={1}  def={8}   fmt={v=>String(v)}          onChange={v=>{cfg.current.substeps  =v;}}/>
//       </div>

//       <p style={s.hint}>Drag to orbit · Scroll to zoom · Click to poke</p>

//       <div style={{...s.bar,bottom:64}}>
//         {(["cube","sphere","tower"] as Shape[]).map(sh=>(
//           <Btn key={sh} onClick={()=>act.current?.reset(sh)}>
//             {({cube:"⬛ Cube",sphere:"⬤ Sphere",tower:"▮ Tower"})[sh]}
//           </Btn>
//         ))}
//       </div>

//       <div style={s.bar}>
//         <Btn onClick={()=>act.current?.drop()}>▼ Drop</Btn>
//         <Btn onClick={()=>act.current?.smash()}>💥 Smash</Btn>
//         <Btn onClick={()=>act.current?.melt()}>~ Melt</Btn>
//         <Btn onClick={()=>act.current?.toggleSprings()}>⊞ Springs</Btn>
//         <Btn onClick={()=>act.current?.toggleWireframe()}>◈ Wire</Btn>
//       </div>
//     </div>
//   );
// }

// function SRow({label,min,max,step,def,fmt,onChange}:SlRow){
//   const valRef=useRef<HTMLSpanElement>(null);
//   return(
//     <div style={s.slRow}>
//       <label style={{textTransform:"uppercase"}}>{label}</label>
//       <input type="range" min={min} max={max} step={step} defaultValue={def}
//         style={{width:90,accentColor:"#ffd700",cursor:"pointer"}}
//         onChange={e=>{const v=Number(e.target.value); if(valRef.current) valRef.current.textContent=fmt(v); onChange(v);}}/>
//       <span ref={valRef} style={s.slVal}>{fmt(def)}</span>
//     </div>
//   );
// }
// function Btn({onClick,children}:BtnP){
//   return(
//     <button onClick={onClick} style={s.btn}
//       onMouseEnter={e=>{e.currentTarget.style.background="rgba(255,215,0,0.22)";}}
//       onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,215,0,0.07);";}}>
//       {children}
//     </button>
//   );
// }

// const mono="'Courier New',monospace";
// const s:Record<string,CSSProperties>={
//   root:    {position:"relative",width:"100vw",height:"100vh"},
//   canvas:  {position:"absolute",inset:0,width:"100%",height:"100%"},
//   hud:     {position:"fixed",top:20,left:20,fontFamily:mono,zIndex:10,pointerEvents:"none"},
//   hudTitle:{fontSize:13,letterSpacing:3,textTransform:"uppercase",marginBottom:14,fontWeight:"bold",color:"#ffd700"},
//   row:     {fontSize:11,color:"#777",margin:"4px 0"},
//   gold:    {color:"#ffd700"},
//   panel:   {position:"fixed",top:20,right:20,zIndex:10,display:"flex",flexDirection:"column",gap:14,alignItems:"flex-end"},
//   slRow:   {display:"flex",alignItems:"center",gap:10,fontSize:11,letterSpacing:1,color:"#666",fontFamily:mono},
//   slVal:   {color:"#ffd700",minWidth:38,textAlign:"right",fontFamily:mono},
//   hint:    {position:"fixed",bottom:110,left:"50%",transform:"translateX(-50%)",fontFamily:mono,fontSize:10,color:"rgba(255,215,0,0.28)",letterSpacing:2,textTransform:"uppercase",whiteSpace:"nowrap",pointerEvents:"none"},
//   bar:     {position:"fixed",bottom:22,left:"50%",transform:"translateX(-50%)",display:"flex",gap:10,zIndex:10},
//   btn:     {background:"rgba(255,215,0,0.07)",border:"1px solid rgba(255,215,0,0.35)",color:"#ffd700",padding:"9px 18px",fontFamily:mono,fontSize:11,letterSpacing:2,textTransform:"uppercase",cursor:"pointer",transition:"background 0.15s"},
// };

"use client";

import { useEffect, useRef } from "react";
import { colorForId } from "../lib/squish/colors";
import { getPoseBounds, getPoseCenter, translatePose } from "../lib/squish/orientation";
import { makeActions, type Actions } from "../lib/squish/sim-core";
import { createRenderer } from "../lib/squish/renderer";
import { buildShape } from "../lib/squish/shapes";
import { DEFAULT_PRISM_DIMENSIONS, type Config, type Orientation, type PrismDimensions, type ShapeName, type SimState } from "../lib/squish/types";
import { HUD, ShapeBar, SliderPanel, ActionBar } from "../lib/squish/ui";

type Stats = {
  bodies: number;
  springs: number;
  broken: number;
  pct: string;
  status: string;
};

export default function SquishySim() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfg = useRef<Config>({ stiffness: 1500, damping: 0.99, breakRatio: 2, substeps: 10 });
  const actionsRef = useRef<Actions | null>(null);
  const statsRef = useRef<Stats>({ bodies: 1, springs: 0, broken: 0, pct: "0%", status: "READY" });
  const orientation = useRef<Orientation>({ x: 0, y: 0, z: 0 });
  const prismDimensions = useRef<PrismDimensions>({ ...DEFAULT_PRISM_DIMENSIONS });
  const selectedShape = useRef<ShapeName>("prism");
  const previewId = useRef(1);
  const nextId = useRef(2);
  const bodiesRef = useRef<SimState[]>([]);
  const basePoseRef = useRef<Float32Array | null>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer> | null>(null);

  const getDroppedBodies = () => bodiesRef.current.filter((body) => body.dropped);
  const getPreview = () => bodiesRef.current.find((body) => !body.dropped) ?? null;

  const updateStats = () => {
    const bodies = bodiesRef.current;
    const springs = bodies.reduce((sum, body) => sum + body.springs.length, 0);
    const broken = bodies.reduce((sum, body) => sum + body.springs.filter((spring) => spring.broken).length, 0);
    const hasDroppedBody = bodies.some((body) => body.dropped);
    statsRef.current = {
      bodies: bodies.length,
      springs,
      broken,
      pct: springs ? `${(broken / springs * 100).toFixed(1)}%` : "0%",
      status: hasDroppedBody ? statsRef.current.status : "READY",
    };
  };

  const stagePreviewBody = (preview: SimState) => {
    const basePose = basePoseRef.current;
    if (!basePose) return;

    preview.pos.set(basePose);
    preview.prev.set(basePose);

    const [cx, cy, cz] = getPoseCenter(basePose);
    const rx = orientation.current.x * Math.PI / 180;
    const ry = orientation.current.y * Math.PI / 180;
    const rz = orientation.current.z * Math.PI / 180;
    const sx = Math.sin(rx);
    const cxr = Math.cos(rx);
    const sy = Math.sin(ry);
    const cyr = Math.cos(ry);
    const sz = Math.sin(rz);
    const czr = Math.cos(rz);

    for (let i = 0; i < basePose.length; i += 3) {
      let x = basePose[i] - cx;
      let y = basePose[i + 1] - cy;
      let z = basePose[i + 2] - cz;

      const y1 = y * cxr - z * sx;
      const z1 = y * sx + z * cxr;
      y = y1;
      z = z1;

      const x2 = x * cyr + z * sy;
      const z2 = -x * sy + z * cyr;
      x = x2;
      z = z2;

      const x3 = x * czr - y * sz;
      const y3 = x * sz + y * czr;

      preview.pos[i] = cx + x3;
      preview.pos[i + 1] = cy + y3;
      preview.pos[i + 2] = cz + z;
      preview.prev[i] = preview.pos[i];
      preview.prev[i + 1] = preview.pos[i + 1];
      preview.prev[i + 2] = preview.pos[i + 2];
    }

    const droppedBodies = getDroppedBodies();
    if (!droppedBodies.length) return;

    let worldTop = -Infinity;
    for (const body of droppedBodies) {
      const bounds = getPoseBounds(body.pos);
      if (bounds.maxY > worldTop) worldTop = bounds.maxY;
    }

    const previewBounds = getPoseBounds(preview.pos);
    const desiredMinY = worldTop + 0.8;
    if (desiredMinY > previewBounds.minY) {
      translatePose(preview.pos, preview.prev, 0, desiredMinY - previewBounds.minY, 0);
    }
  };

  const createPreviewBody = (shape: ShapeName, id = previewId.current) => {
    const preview = buildShape(shape, { id, color: colorForId(id), dropped: false }, prismDimensions.current);
    basePoseRef.current = new Float32Array(preview.pos);
    stagePreviewBody(preview);
    return preview;
  };

  const loadScene = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.load(bodiesRef.current);
    updateStats();
  };

  const replacePreview = (shape: ShapeName = selectedShape.current) => {
    const preview = createPreviewBody(shape);
    bodiesRef.current = [...getDroppedBodies(), preview];
    loadScene();
  };

  const handleOrientationChange = (axis: keyof Orientation, value: number) => {
    orientation.current[axis] = value;

    const renderer = rendererRef.current;
    if (renderer) renderer.setPreviewOrientation(orientation.current);

    const preview = getPreview();
    if (preview) {
      stagePreviewBody(preview);
    }
  };

  const handlePrismDimensionChange = (axis: keyof PrismDimensions, value: number) => {
    prismDimensions.current[axis] = value;

    if (selectedShape.current === "prism") {
      replacePreview("prism");
    }
  };

  const handleShapeChange = (shape: ShapeName) => {
    selectedShape.current = shape;
    replacePreview(shape);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    renderer.setPreviewOrientation(orientation.current);

    bodiesRef.current = [createPreviewBody(selectedShape.current)];
    loadScene();

    const spawnPreview = (mode: "drop" | "smash") => {
      const preview = getPreview();
      if (!preview) return;

      preview.dropped = true;
      if (mode === "smash") {
        const [cx, , cz] = getPoseCenter(preview.pos);
        for (let i = 0; i < preview.N; i++) {
          const base = i * 3;
          const str = Math.max(0, 1.4 - Math.hypot(preview.pos[base] - cx, preview.pos[base + 2] - cz) * 0.8);
          const j = (Math.random() - 0.5) * 0.12;
          preview.prev[base + 1] = preview.pos[base + 1] + str * 1.8;
          preview.prev[base] -= j;
          preview.prev[base + 2] -= j;
        }
      }

      previewId.current = nextId.current++;
      const nextPreview = createPreviewBody(selectedShape.current);
      bodiesRef.current = [...getDroppedBodies(), nextPreview];
      statsRef.current.status = mode === "smash" ? "SMASHED" : "SIMULATING";
      loadScene();
    };

    actionsRef.current = makeActions({
      drop: () => spawnPreview("drop"),
      smash: () => spawnPreview("smash"),
      melt: () => {
        for (const body of getDroppedBodies()) {
          body.springs.forEach((spring) => {
            spring.broken = true;
          });
        }
        statsRef.current.status = "MELTED";
        updateStats();
      },
      clear: () => {
        bodiesRef.current = [];
        bodiesRef.current = [createPreviewBody(selectedShape.current)];
        statsRef.current.status = "READY";
        loadScene();
      },
      toggleSprings: () => renderer.toggleSprings(),
      toggleWireframe: () => renderer.toggleWireframe(),
    });

    const resize = () => renderer.resize();
    window.addEventListener("resize", resize);
    resize();

    let tick = 0;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      renderer.update(cfg.current);
      if (tick++ % 10 === 0) updateStats();
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      rendererRef.current = null;
      bodiesRef.current = [];
      basePoseRef.current = null;
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
      <HUD statsRef={statsRef} />
      <SliderPanel cfg={cfg} onOrientationChange={handleOrientationChange} onPrismDimensionChange={handlePrismDimensionChange} />
      <ShapeBar onShape={handleShapeChange} />
      <ActionBar actionsRef={actionsRef} />
    </div>
  );
}
