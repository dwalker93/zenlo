import { getAuth } from "@/lib/server"

const handler = (req: Request) => getAuth().handler(req)

export { handler as GET, handler as POST }
