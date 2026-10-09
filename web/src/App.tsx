import { Navigate, Route, Routes } from 'react-router';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { Editor } from './pages/Editor';
import { Admin } from './pages/Admin';
import { MaintenanceBanner } from './components/Maintenance';

export function App() {
  return (<>
    <MaintenanceBanner />
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Home />} />
      <Route path="/task/:id" element={<Editor />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  </>);
}
