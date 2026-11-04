import { ControlRoomScreen } from '@/components/cx/ControlRoom'

export const metadata = { title: 'Control Room' }

/** The store home is the Control Room; the store overview is one click away (/store/control-room/overview). */
export default function StoreHomePage() {
  return <ControlRoomScreen />
}
