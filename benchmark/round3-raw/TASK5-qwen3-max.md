# Round 3 TASK5 — Translation (中英日三语翻译) 原始答案

## qwen3-max
**耗时: 16141ms**

1. English Version:
In an event-driven architecture (EDA), the CQRS pattern separates read and write operations into distinct models. The command side records all state changes via event sourcing, while the query side maintains materialized views to optimize read performance. Eventual consistency is a core characteristic of this architecture—after a write is acknowledged, the read side may experience a delay ranging from several milliseconds to several seconds before reflecting the latest state. Compensating transactions are used to handle business rollbacks in distributed scenarios.

2. Japanese Version:
イベント駆動型アーキテクチャ（EDA）において、CQRSパターンは読み取り操作と書き込み操作を異なるモデルに分離する。コマンドサイド（Command Side）はイベントソーシング（Event Sourcing）によりすべての状態変更を記録し、クエリサイド（Query Side）は読み取り性能を最適化するためにマテリアライズドビュー（Materialized View）を維持する。このアーキテクチャの中核となる特徴は「結果整合性（Eventual Consistency）」であり、書き込みが確認された後でも、読み取り側が最新の状態を反映するまで数ミリ秒から数秒の遅延が発生する可能性がある。分散環境における業務ロールバックを処理するために、補償トランザクション（Compensating Transaction）が用いられる。

3. Chinese Version (Back-translation from English):
在事件驱动架构（EDA）中，CQRS 模式将读写操作分离到不同的模型中进行处理。命令端通过事件溯源记录所有状态变更，而查询端则维护物化视图以优化读取性能。最终一致性是该架构的核心特征——写入操作确认后，读取端可能需要几毫秒到几秒的延迟才能反映最新状态。补偿事务用于处理分布式场景中的业务回滚。
