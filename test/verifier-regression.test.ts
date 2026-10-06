import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { evaluateCheck, getDiffStat, review, runCommand } from '../src/verifier.js';
import { makeProject } from './helpers.js';

const emptyDiff = { files: [], totalAdded: 0, totalDeleted: 0, isGitRepo: true, rawSummary: '' };

test('plain checklist without verification cannot claim completion', async () => {
  const dir = await makeProject();
  try {
    const result = await review(dir, [{id:'a',text:'Verify manually',done:false}], [], emptyDiff);
    assert.equal(result.review.complete, false);
    assert.equal(result.checklist[0]?.done, false);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('file checks reject lexical and symlink escapes', async () => {
  const dir = await makeProject();
  const outside = await fs.mkdtemp(path.join(path.dirname(dir), 'outside-check-'));
  try {
    await fs.writeFile(path.join(outside,'fixture.txt'), 'external fixture');
    await fs.symlink(outside, path.join(dir,'external'), 'dir');
    for (const name of [path.join(outside,'fixture.txt'), path.relative(dir,path.join(outside,'fixture.txt')), 'external/fixture.txt']) {
      assert.equal(await evaluateCheck(dir, {type:'fileExists',path:name}), false, name);
      assert.equal(await evaluateCheck(dir, {type:'fileContains',path:name,pattern:'external'}), false, name);
    }
    await fs.writeFile(path.join(dir,'safe.txt'),'safe');
    assert.equal(await evaluateCheck(dir,{type:'fileContains',path:'safe.txt',pattern:'safe'}),true);
  } finally { await fs.rm(dir,{recursive:true,force:true}); await fs.rm(outside,{recursive:true,force:true}); }
});

test('git filenames retain whitespace, quotes, tabs and arrow text', async () => {
  const dir = await makeProject();
  try {
    const names=[' leading.txt','trailing.txt ','a\tb.txt','a\nb.txt','old -> new.txt','quote".txt'];
    for(const name of names) await fs.writeFile(path.join(dir,name),'one\n');
    let diff=await getDiffStat(dir);
    assert.deepEqual(diff.files.map(f=>f.path).sort(), [...names].sort());
    for(const file of diff.files) assert.equal(file.added,1,file.path);
    await runCommand('git add -A && git commit -qm names',dir,30000);
    for(const name of names) await fs.appendFile(path.join(dir,name),'two\n');
    diff=await getDiffStat(dir);
    assert.deepEqual(diff.files.map(f=>f.path).sort(), [...names].sort());
    for(const file of diff.files) assert.equal(file.added,1,file.path);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('untracked symlinks are not read as target file content', async () => {
  const dir=await makeProject();
  try {
    await fs.symlink('PROJECT_GOAL.md',path.join(dir,'goal-link'));
    const diff=await getDiffStat(dir);
    assert.equal(diff.files.find(f=>f.path==='goal-link')?.added,0);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('rename preserves both source deletion and destination addition', async()=> {
  const dir=await makeProject();
  try {
    await fs.rename(path.join(dir,'greet.test.js'),path.join(dir,'renamed test.js'));
    await runCommand('git add -A',dir,30000);
    const diff=await getDiffStat(dir);
    assert.ok(diff.files.some(f=>f.path==='greet.test.js' && f.status==='D'));
    assert.ok(diff.files.some(f=>f.path==='renamed test.js' && f.added>0));
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('untracked line counts handle empty and unterminated files', async()=> {
  const dir=await makeProject();
  try {
    await fs.writeFile(path.join(dir,'empty.txt'),'');
    await fs.writeFile(path.join(dir,'one.txt'),'one');
    await fs.writeFile(path.join(dir,'two.txt'),'one\ntwo\n');
    const diff=await getDiffStat(dir);
    for(const [name,count] of [['empty.txt',0],['one.txt',1],['two.txt',2]] as const) {
      assert.equal(diff.files.find(f=>f.path===name)?.added,count);
    }
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
