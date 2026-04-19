import { Router, type IRouter } from "express";
import healthRouter from "./health";
import keysRouter from "./keys";
import proxyRouter from "./proxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use(keysRouter);

export default router;

export { proxyRouter };
