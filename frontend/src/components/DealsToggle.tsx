// Table / Board switch shared by the Deals table and the Pipeline board.
import { NavLink } from 'react-router-dom'

export default function DealsToggle() {
  return (
    <div className="seg" role="group" aria-label="Deals view">
      <NavLink to="/deals" className={({ isActive }) => `seg-link${isActive ? ' on' : ''}`}>Table</NavLink>
      <NavLink to="/pipeline" className={({ isActive }) => `seg-link${isActive ? ' on' : ''}`}>Board</NavLink>
    </div>
  )
}
