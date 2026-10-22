import { getApi } from "@/lib/server"

const handler = (req: Request) => getApi().fetch(req)

export { handler as GET, handler as POST }
