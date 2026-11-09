declare global {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let google: any;
    interface Window {
        sendRequestsStatistic: (is_running: boolean) => void;
        run_panel?: {
            is_running?: boolean;
        };
    }
}

export {};
