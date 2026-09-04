import { FunnelChart } from './FunnelChart';
import { IncrementalityPanel } from './IncrementalityPanel';
import { EventList } from './EventList';
import './index.css';

function App() {
  return (
    <div className="container">
      <div className="header">
        <h1>RecoveryOps Dashboard</h1>
      </div>
      
      <div className="grid">
        <FunnelChart />
        <IncrementalityPanel />
      </div>
      
      <EventList />
    </div>
  );
}

export default App;
