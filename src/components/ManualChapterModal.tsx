import { useRef, useState } from 'react';
import type { Project } from '../../shared/types';
import { manualChapterRequestSchema } from '../../shared/manual-chapters';
import { nextChapterNumber } from '../hooks/generationState';
import { decodeChapterFile, MAX_TEXT_FILE_BYTES } from '../hooks/manualChapter';
import Modal from './Modal';

export default function ManualChapterModal({ project, busy, onClose, onSave }: {
  project: Project; busy: boolean; onClose: () => void;
  onSave: (input: {number:number;title:string;content:string;requestId:string;workflowId?:string}) => Promise<void>;
}) {
  const [number, setNumber] = useState(String(nextChapterNumber(project)));
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [encoding, setEncoding] = useState<'utf-8'|'gb18030'>('utf-8');
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{payload:string;id:string} | undefined>(undefined);
  const fileSequence = useRef(0);
  const saving = useRef(false);
  const locked = busy || loading;
  return <Modal wide title="手动添加正文" close={onClose} busy={locked} dirty={!!title || !!content} error={error}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (locked || saving.current) return;
      saving.current = true;
      setError('');
      try {
        const input = {number:Number(number),title:title.trim(),content,workflowId:project.workflow?.id};
        const payload = JSON.stringify(input);
        if (request.current?.payload !== payload) request.current = {payload,id:crypto.randomUUID()};
        const parsed = manualChapterRequestSchema.parse({...input,requestId:request.current!.id});
        await onSave(parsed);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : '保存失败，输入已保留。');
      } finally { saving.current = false; }
    }}>
      <p className="info-note">直接编辑或上传一份 TXT 正文，每次添加一章。保存为本地正式章节后可继续编辑，并在平台页上传 / 送审；此处不会触发远端发布。</p>
      <label>文本文件编码<select value={encoding} disabled={locked} onChange={e => setEncoding(e.target.value as typeof encoding)}><option value="utf-8">UTF-8（默认）</option><option value="gb18030">GB18030 / GBK</option></select></label>
      <label>上传 TXT 正文（可选，最多 2 MB）<input type="file" accept=".txt,text/plain" disabled={locked} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value='';
        if (!file) return;
        const sequence = ++fileSequence.current;
        setError(''); setLoading(true);
        try {
          if (!/\.txt$/i.test(file.name)) throw new Error('目前支持 TXT 纯文本正文，请先将文档另存为 TXT。');
          if(file.size > MAX_TEXT_FILE_BYTES) throw new Error('文件不能超过 2 MB。');
          const text = decodeChapterFile(await file.arrayBuffer(),encoding);
          if(sequence !== fileSequence.current) return;
          setContent(text); setFileName(file.name);
          if(!title.trim()) setTitle(file.name.replace(/\.txt$/i,'').slice(0,120));
        } catch(failure) { if(sequence === fileSequence.current) setError(failure instanceof Error ? failure.message : '读取失败，原输入未改变。'); }
        finally { if(sequence === fileSequence.current) setLoading(false); }
      }}/></label>
      {fileName && <p className="info-note">已载入：{fileName}。可在下方修改，正文不会自动去除标题或拆分章节。</p>}
      <label>章号<input required type="number" min={1} max={1000000} step={1} value={number} disabled={locked} onChange={e=>setNumber(e.target.value)}/></label>
      <label>章节标题<input required maxLength={120} value={title} disabled={locked} placeholder="例如：第1章 故事开始" onChange={e=>setTitle(e.target.value)}/></label>
      <label>正文<textarea required rows={18} maxLength={200000} value={content} disabled={locked} placeholder="在这里粘贴或编写章节正文，也可从 TXT 文件载入" onChange={e=>setContent(e.target.value)}/></label>
      <p className="info-note">{content.length.toLocaleString()} / 200000 字符 · 相同章号不会覆盖已有章节；请在书稿编辑器修改原章。</p>
      <button className="button primary full" disabled={locked || !title.trim() || !content.trim()}>保存为正式章节</button>
    </form>
  </Modal>;
}
