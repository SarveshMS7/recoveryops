import { useEffect, useState } from 'react';

type FunnelItem = {
  state: string;
  count: string;
};

export function FunnelChart() {
  const [data, setData] = useState<FunnelItem[]>([]);

  useEffect(() => {
    fetch('/api/funnel')
      .then(res => res.json())
      .then(setData)
      .catch(console.error);
  }, []);

  const maxCount = Math.max(...data.map(d => parseInt(d.count, 10)), 1);

  return (
    <div className="card">
      <h2>Conversion Funnel</h2>
      {data.map((item) => {
        const count = parseInt(item.count, 10);
        const percent = (count / maxCount) * 100;
        return (
          <div key={item.state} className="funnel-bar">
            <div className="funnel-label">{item.state}</div>
            <div 
              className="funnel-fill" 
              style={{ width: `${percent}%` }}
            >
              {count}
            </div>
          </div>
        );
      })}
    </div>
  );
}
