// 실제 QA 응답을 기존 worker의 합성 저장소에 연결한다. Chrome 실측은 아니다.
const {worker,expected,profileKey,profile}=require('./conversation_fixture.cjs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',async()=>{
  try{
    const packet=JSON.parse(input),f=worker(packet.data||{[profileKey]:{...profile,profile:packet.profile}});
    if(packet.operation==='profile'){
      const response=await f.send({type:'gyeote:profile-save',expectedRevision:f.data[profileKey].revision,profile:packet.profile});
      if(!response.ok)throw Error(response.error);
      process.stdout.write(JSON.stringify({data:f.data}));return;
    }
    const read=await f.action('get');if(!read.ok)throw Error(read.error);
    const fields={...expected(read.state),pairId:packet.pairId,profileRevision:f.data[profileKey].revision};
    const begun=await f.action('begin',fields);if(!begun.ok)throw Error(begun.error);
    if(packet.operation==='commit'){
      if(JSON.stringify(begun.input)!==JSON.stringify(packet.submitted))throw Error('submitted_context_changed');
      const saved=await f.action('append',{...fields,question:packet.question,answer:packet.answer});
      if(!saved.ok)throw Error(saved.error);
      const reread=await worker(f.data).action('get');if(!reread.ok)throw Error(reread.error);
      process.stdout.write(JSON.stringify({data:f.data,restored:reread.state}));return;
    }
    process.stdout.write(JSON.stringify({data:f.data,input:begun.input}));
  }catch(error){process.stderr.write(error.message);process.exitCode=1;}
});
