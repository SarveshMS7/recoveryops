import { useEffect, useState } from 'react';

type IncrItem = {
  group: string;
  total: number;
  recovered: number;
  recovery_rate_pct: string;
};

export function IncrementalityPanel() {
  const [data, setData] = useState<IncrItem[]>([]);

  useEffect(() => {
    fetch('/api/incrementality')
      .then(res => res.json())
      .then(setData)
      .catch(console.error);
  }, []);

  const treatment = data.find(d => d.group === 'treatment');
  const control = data.find(d => d.group === 'control');

  return (
    <div className="card">
      <h2>Incrementality (Treatment vs Control)</h2>
      <div className="grid">
        <div className="metric-box">
          <div className="metric-label">Treatment Recovery Rate</div>
          <div className="metric-value">{treatment ? treatment.recovery_rate_pct : '0.00'}%</div>
          <div className="metric-label">
            {treatment ? `${treatment.recovered} / ${treatment.total}` : '0 / 0'} events
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Control Recovery Rate</div>
          <div className="metric-value">{control ? control.recovery_rate_pct : '0.00'}%</div>
          <div className="metric-label">
            {control ? `${control.recovered} / ${control.total}` : '0 / 0'} events
          </div>
        </div>
      </div>
    </div>
  );
}
