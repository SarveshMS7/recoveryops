import { useEffect, useState } from 'react';

type EventItem = {
  id: string;
  source_type: string;
  amount: string;
  currency: string;
  raw_reason: string;
  detected_at: string;
  experiment_group: string;
  state: string;
};

type TimelineItem = {
  id: string;
  stage: string;
  detail: any;
  occurred_at: string;
};

export function EventList() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);

  useEffect(() => {
    fetch('/api/events')
      .then(res => res.json())
      .then(setEvents)
      .catch(console.error);
  }, []);

  const handleEventClick = (id: string) => {
    if (selectedId === id) {
      setSelectedId(null);
      setTimeline([]);
      return;
    }
    
    setSelectedId(id);
    fetch(`/api/events/${id}/timeline`)
      .then(res => res.json())
      .then(setTimeline)
      .catch(console.error);
  };

  return (
    <div className="card" style={{ marginTop: '24px' }}>
      <h2>Recent Events & Audit Timeline</h2>
      <div style={{ display: 'flex', gap: '24px' }}>
        <div style={{ flex: 2 }}>
          <table>
            <thead>
              <tr>
                <th>Event ID</th>
                <th>Amount</th>
                <th>Group</th>
                <th>Current State</th>
              </tr>
            </thead>
            <tbody>
              {events.map((evt) => (
                <tr 
                  key={evt.id} 
                  className="clickable"
                  onClick={() => handleEventClick(evt.id)}
                  style={{ background: selectedId === evt.id ? '#f1f8ff' : undefined }}
                >
                  <td>{evt.id.substring(0, 8)}...</td>
                  <td>{evt.amount} {evt.currency}</td>
                  <td>
                    <span className={`badge ${evt.experiment_group}`}>
                      {evt.experiment_group}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${evt.state.toLowerCase()}`}>
                      {evt.state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
        <div style={{ flex: 1, borderLeft: '1px solid #e1e4e8', paddingLeft: '24px' }}>
          {selectedId ? (
            <div>
              <h3>Timeline for {selectedId.substring(0, 8)}...</h3>
              <ul className="timeline">
                {timeline.map((item) => (
                  <li key={item.id}>
                    <div className="timeline-time">
                      {new Date(item.occurred_at).toLocaleTimeString()}
                    </div>
                    <div className="timeline-stage">{item.stage}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div style={{ color: '#586069', marginTop: '20px' }}>
              Click an event to view its full audit timeline.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
