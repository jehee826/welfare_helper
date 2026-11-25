(() => {
  const bulletLine=/^\s*[-*•·▪◦]\s+(\S.*)$/u;
  const circledLine=/^\s*([①-⑳])\s*(\S.*)$/u;
  const orderedLine=/^\s*(\d{1,2})[.)]\s+(\S.*)$/u;
  const headingLine=/^\s*#{1,6}\s+(\S.*?)\s*#*\s*$/u;
  const boldHeading=/^\s*\*\*([^*]{1,40})\*\*\s*[:：]?\s*$/u;
  const labelLine=/^([^\s:：*][^:：\n]{0,15}?)\s*[:：]\s+(\S.*)$/u;
  const sentenceBreak=/(?<=[^\d\s][.!?])\s+(?=\S)/u;

  /**
   * 한 단락을 문장 경계로 나눠 minLength 이상이 될 때까지 묶는다.
   */
  function chunkSentences(text,minLength){
    const sentences=text.split(sentenceBreak),chunks=[];let current='';
    for(const sentence of sentences){
      current=current?current+' '+sentence:sentence;
      if(current.length>=minLength){chunks.push(current);current='';}
    }
    if(current&&chunks.length&&current.length<minLength/2)chunks[chunks.length-1]+=' '+current;
    else if(current)chunks.push(current);
    return chunks;
  }

  /**
   * 답변 원문을 표시용 블록 목록으로 바꾼다. 원문 글자는 버리지 않고 목록 기호·마크다운 표시만 구조로 옮긴다.
   */
  function blocks(text){
    const result=[];let list=null;
    const closeList=()=>{list=null;};
    for(const raw of String(text||'').replace(/\r\n?/g,'\n').split('\n')){
      const line=raw.trimEnd();
      if(!line.trim()){closeList();continue;}
      let match;
      if((match=headingLine.exec(line))||(match=boldHeading.exec(line))){closeList();result.push({type:'heading',text:match[1]});continue;}
      if((match=bulletLine.exec(line))){
        if(list?.type!=='ul'){list={type:'ul',items:[]};result.push(list);}
        list.items.push({text:match[1]});continue;
      }
      if((match=circledLine.exec(line))||(match=orderedLine.exec(line))){
        const number=/\d/.test(match[1])?Number(match[1]):match[1].charCodeAt(0)-0x245f;
        if(list?.type!=='ol'||number!==list.items.at(-1).number+1){list={type:'ol',start:number,items:[]};result.push(list);}
        list.items.push({text:match[2],number});continue;
      }
      if(list&&/^\s{2,}\S/.test(raw)){list.items.at(-1).text+=' '+line.trim();continue;}
      closeList();
      const paragraph=line.trim();
      if(paragraph.length>160)for(const chunk of chunkSentences(paragraph,90))result.push({type:'paragraph',text:chunk});
      else result.push({type:'paragraph',text:paragraph});
    }
    return result;
  }

  /**
   * 요약문을 항목 목록으로 나눈다. 목록 기호가 없으면 문장, 한 문장이면 쉼표로 나열한 주제를 항목으로 쓴다.
   */
  function summaryItems(text){
    const parsed=blocks(text),items=[];
    for(const block of parsed){
      if(block.type==='ul'||block.type==='ol')items.push(...block.items.map(item=>item.text));
      else items.push(...block.text.split(sentenceBreak));
    }
    if(items.length===1&&items[0].length>50){
      const parts=items[0].split(/\s*,\s+/u).filter(Boolean);
      if(parts.length>=3)return parts;
    }
    return items.map(item=>item.trim()).filter(Boolean);
  }

  function appendInline(target,text){
    const parts=String(text).split('**');
    parts.forEach((part,index)=>{
      if(!part)return;
      if(index%2){const strong=target.ownerDocument.createElement('strong');strong.textContent=part;target.append(strong);}
      else target.append(target.ownerDocument.createTextNode(part));
    });
  }

  function appendLabeled(target,text){
    const match=labelLine.exec(text);
    if(!match||match[1].length>12||(match[1].match(/\s/g)||[]).length>2||/^\d+$/.test(match[1])||/https?$/i.test(match[1])){appendInline(target,text);return;}
    const label=target.ownerDocument.createElement('strong');label.className='answer-label';label.textContent=match[1].replace(/\*\*/g,'')+': ';
    target.append(label);appendInline(target,match[2]);
  }

  /**
   * container의 내용을 서식 있는 답변으로 교체한다. caret이 참이면 마지막 블록 끝에 입력 중 표시를 붙인다.
   */
  function render(container,text,{caret=false}={}){
    const doc=container.ownerDocument,fragment=doc.createDocumentFragment();let last=null;
    for(const block of blocks(text)){
      let node;
      if(block.type==='heading'){node=doc.createElement('h4');appendInline(node,block.text);last=node;}
      else if(block.type==='paragraph'){node=doc.createElement('p');appendLabeled(node,block.text);last=node;}
      else{
        node=doc.createElement(block.type);
        if(block.type==='ol'&&block.start!==1)node.start=block.start;
        for(const item of block.items){const li=doc.createElement('li');if(block.type==='ol')li.value=item.number;appendLabeled(li,item.text);node.append(li);last=li;}
      }
      fragment.append(node);
    }
    if(caret){
      const mark=doc.createElement('span');mark.className='typing-caret';mark.setAttribute('aria-hidden','true');
      (last||fragment).append(mark);
    }
    container.replaceChildren(fragment);
  }

  /**
   * 요약 항목을 목록으로 container에 표시한다.
   */
  function renderSummary(container,text){
    const doc=container.ownerDocument,items=summaryItems(text);
    if(items.length<2){const p=doc.createElement('p');appendInline(p,items[0]||String(text||''));container.replaceChildren(p);return;}
    const list=doc.createElement('ul');
    for(const item of items){const li=doc.createElement('li');appendLabeled(li,item);list.append(li);}
    container.replaceChildren(list);
  }

  const api=Object.freeze({blocks,summaryItems,render,renderSummary});
  globalThis.GyeoteAnswerFormat=api;
  if(typeof module!=='undefined')module.exports=api;
})();
