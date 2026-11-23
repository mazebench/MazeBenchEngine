import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';
import test from 'node:test';
import {hiddenAsciiGlyphMap} from '../render-ascii/v1/glyph-contract.mjs';
import {hiddenAsciiGlyphMap as canonicalMap} from '../render-ascii/v2/glyph-contract.mjs';

// Read the shipped WOFF metrics directly so the check needs no font tooling
// and catches missing glyphs, system-font fallback, and double-width letters.
async function fontMetrics(filename) {
  const bytes=await readFile(new URL(`../ui/fonts/${filename}`,import.meta.url));
  assert.equal(bytes.toString('ascii',0,4),'wOFF');
  const tables=new Map();
  for(let i=0;i<bytes.readUInt16BE(12);i++){
    const entry=44+i*20,offset=bytes.readUInt32BE(entry+4),length=bytes.readUInt32BE(entry+8);
    let data=bytes.subarray(offset,offset+length);
    if(length<bytes.readUInt32BE(entry+12))data=inflateSync(data);
    tables.set(bytes.toString('ascii',entry,entry+4),data);
  }
  const cmap=tables.get('cmap');let mapping;
  for(let i=0;i<cmap.readUInt16BE(2);i++){
    const entry=4+i*8,offset=cmap.readUInt32BE(entry+4);
    if(cmap.readUInt16BE(entry)===3&&cmap.readUInt16BE(entry+2)===1&&cmap.readUInt16BE(offset)===4)mapping=cmap.subarray(offset);
  }
  assert.ok(mapping,'Font must expose a Unicode BMP character map');
  const count=mapping.readUInt16BE(6)/2,start=16+count*2,delta=start+count*2,ranges=delta+count*2;
  const hmtx=tables.get('hmtx'),metricsCount=tables.get('hhea').readUInt16BE(34);
  return {
    em:tables.get('head').readUInt16BE(18),
    width(character){
      const code=character.codePointAt(0);
      for(let i=0;i<count;i++){
        const first=mapping.readUInt16BE(start+i*2),last=mapping.readUInt16BE(14+i*2);
        if(code<first||code>last)continue;
        const shift=mapping.readInt16BE(delta+i*2),range=mapping.readUInt16BE(ranges+i*2);
        let glyph=range?mapping.readUInt16BE(ranges+i*2+range+(code-first)*2):code;
        if(!range||glyph)glyph=(glyph+shift)&0xffff;
        return glyph?hmtx.readUInt16BE(Math.min(glyph,metricsCount-1)*4):null;
      }
      return null;
    }
  };
}

test('every normal and seeded ASCII glyph has a real, equal-width bundled glyph',async()=>{
  const fonts=await Promise.all(['mazebench-ascii.woff','mazebench-ascii-coptic.woff'].map(fontMetrics));
  const map=await hiddenAsciiGlyphMap('1');
  const current=await canonicalMap('1');
  const glyphs=new Set([' ','P','p','G','g',...map.keys(),...map.values(),...current.keys(),...current.values()]);
  for(const glyph of glyphs){
    assert.equal(Array.from(glyph).length,1);
    const font=fonts.find(font=>font.width(glyph)!==null);
    assert.ok(font,`Missing bundled glyph: ${glyph} U+${glyph.codePointAt(0).toString(16)}`);
    assert.equal(font.width(glyph)/font.em,0.6,`Non-monospaced glyph: ${glyph}`);
  }
});
