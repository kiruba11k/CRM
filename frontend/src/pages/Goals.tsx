// Sales Goals: quarterly targets per salesperson (moved out of Reports).
import Targets from '../components/Targets'

export default function Goals() {
  return (
    <>
      <div className="page-head">
        <div><h1>Sales Goals</h1><p>Quarterly targets per salesperson and currency: won so far, weighted pipeline closing this quarter, attainment against an even pace, and the gap.</p></div>
      </div>
      <Targets />
    </>
  )
}
