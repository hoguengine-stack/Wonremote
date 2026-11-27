
import {createHash, createPublicKey, sign, verify} from "node:crypto";
import {readFileSync} from "node:fs";
import {deepStrictEqual, equal, match} from "node:assert/strict";

const version = "0.1.124";
const asset = "WonRemote-Agent-Update.exe";

function signedFields(item) {
  return ["version="+version, "url="+item.url, "sha256="+item.sha256, "assetName="+item.name];
}

function wireSignatures(item) {
  const v1 = signedFields(item);
  const v2 = ["signatureVersion=2", ...v1, "forceUpdate=false", "updateKind=installer", "arch=x86"];
  return [v1, v2].map(fields => Buffer.from(fields.join("\n"),"utf8"));
}

export function exactUpdate({tag, checksum}) {
  match(tag, /^internal-wonremote-agent123-compat-124-[a-f0-9]{16}$/);
  match(checksum, /^[a-f0-9]{64}$/);
  return {
    name:asset,
    url:"https://github.com/hoguengine-stack/Wonremote/releases/download/"+tag+"/"+asset,
    sha256:checksum,
  };
}

export function checkedExecutable(file, checksum) {
  const bytes=readFileSync(file);
  equal(createHash("sha256").update(bytes).digest("hex"),checksum,"Candidate digest differs");
  equal(bytes.readUInt16LE(0),0x5a4d,"Expected Windows executable");
  const peOffset=bytes.readUInt32LE(0x3c);
  equal(bytes.readUInt32LE(peOffset),0x4550,"Expected PE header");
  equal(bytes.readUInt16LE(peOffset+4),0x14c,"Expected Windows x86 executable");
}

export function verifyCommon124(manifest, pins, publicKey) {
  deepStrictEqual(Object.keys(manifest).sort(),["agentFileUpdates","forceUpdate","version"]);
  equal(manifest.version,version);
  equal(manifest.forceUpdate,false);
  deepStrictEqual(Object.keys(manifest.agentFileUpdates),["x86"]);
  const {signature,signatureV2,...item}=manifest.agentFileUpdates.x86;
  deepStrictEqual(item,exactUpdate(pins));
  const encoded=[signature,signatureV2];
  for(const [index,payload] of wireSignatures(item).entries()) {
    equal(typeof encoded[index],"string");
    equal(verify(null,payload,publicKey,Buffer.from(encoded[index],"base64")),true,"Invalid V"+(index+1)+" signature");
  }
}

export function makeCommon124({privateKey, publicKey, pins, file}) {
  const actualKey=createPublicKey(privateKey).export({type:"spki",format:"der"});
  const trustedKey=createPublicKey(publicKey).export({type:"spki",format:"der"});
  deepStrictEqual(actualKey,trustedKey,"Signer does not match the trusted product key");
  checkedExecutable(file,pins.checksum);
  const item=exactUpdate(pins);
  const [signature,signatureV2]=wireSignatures(item).map(payload=>sign(null,payload,privateKey).toString("base64"));
  const manifest={version, forceUpdate:false, agentFileUpdates:{x86:{...item,signature,signatureV2}}};
  verifyCommon124(manifest,pins,publicKey);
  return manifest;
}