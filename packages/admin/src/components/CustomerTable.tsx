import React, { useEffect, useMemo, useState } from 'react';
import { getServerUrl } from '@wonremote/shared';

interface Customer {
  [key: string]: any;
}

const CustomerTable: React.FC = () => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [groupCol, setGroupCol] = useState('그룹');
  const [storeCol, setStoreCol] = useState('상호명');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch(`${getServerUrl()}/api/list`)
      .then(res => res.json())
      .then(json => {
        if (json.success) setCustomers(json.data || []);
        else setError(json.error || '데이터 로드 실패');
        setLoading(false);
      })
      .catch(() => {
        setError('서버와 연결할 수 없습니다. 서버가 켜져 있는지 확인하세요.');
        setLoading(false);
      });
  }, []);

  const cols = useMemo(() => {
    const s = new Set();
    for (const c of customers) Object.keys(c || {}).forEach(k => s.add(k));
    return Array.from(s);
  }, [customers]);

  const filtered = useMemo(() => {
    if (!search) return customers;
    return customers.filter(c => JSON.stringify(c).includes(search));
  }, [customers, search]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const c of filtered) {
      const g = String(c?.[groupCol] ?? '').trim() || '미분류';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(c);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, groupCol]);

  if (loading) return <div>고객 정보를 불러오는 중...</div>;
  if (error) return <div style={{ color: 'red' }}>{error}</div>;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>고객/매장 그룹</h2>
        <input
          placeholder="검색(전체 문자열)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #ddd', borderRadius: 8 }}
        />
        <label style={{ fontSize: 12 }}>
          그룹컬럼&nbsp;
          <select value={groupCol} onChange={(e) => setGroupCol(e.target.value)}>
            {cols.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>
          매장컬럼&nbsp;
          <select value={storeCol} onChange={(e) => setStoreCol(e.target.value)}>
            {cols.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>

      {grouped.map(([g, list]) => (
        <div key={g} style={{ marginBottom: 16, border: '1px solid #eee', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: 10, background: '#f7f7f7', fontWeight: 700 }}>
            {g} <span style={{ fontWeight: 400, color: '#666' }}>({list.length})</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table border={1} style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ backgroundColor: '#fafafa' }}>
                  <th style={{ padding: 8 }}>{storeCol}</th>
                  {cols.slice(0, 6).map(k => (k === storeCol ? null : <th key={k} style={{ padding: 8 }}>{k}</th>))}
                </tr>
              </thead>
              <tbody>
                {list.map((c, i) => (
                  <tr key={i}>
                    <td style={{ padding: 8, fontWeight: 700 }}>{String(c?.[storeCol] ?? '')}</td>
                    {cols.slice(0, 6).map(k => (k === storeCol ? null : <td key={k} style={{ padding: 8 }}>{String(c?.[k] ?? '')}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
};

export default CustomerTable;
